//! Architecture Studio — modelo de System Design + **validação da arquitectura**.
//!
//! Modela um desenho orientado a eventos (serviços, lojas, brokers, consumidores, relays) e
//! corre regras que apanham erros estruturais ANTES de gerar código: um outbox sem relay que
//! o publique, um evento publicado que ninguém consome, uma subscrição a um evento que
//! ninguém emite, um broker pendurado. É a base honesta do estúdio: o diagrama só vale se a
//! arquitectura fecha.

use serde::{Deserialize, Serialize};

/// Tipo de um componente no diagrama.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Service,
    Store,
    Broker,
    Consumer,
    Relay,
    Gateway,
}

/// Um componente (nó) do desenho.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Component {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    /// Marca uma `Store` como tabela de outbox (escrita transaccional + relay a publicar).
    #[serde(default)]
    pub outbox: bool,
}

/// Como dois componentes se ligam (aresta).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Relation {
    Writes,   // service → store
    Reads,    // relay/service → store
    Publishes, // service/relay → broker (produz um evento)
    Consumes, // consumer → broker (subscreve um evento)
    RoutesTo, // broker → consumer (routing key)
}

/// Uma ligação, opcionalmente nomeando o evento/rota.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Connection {
    pub from: String,
    pub to: String,
    pub relation: Relation,
    #[serde(default)]
    pub event: String,
}

/// O desenho completo.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Architecture {
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub connections: Vec<Connection>,
}

/// Gravidade de um achado de validação.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Error,
    Warning,
}

/// Um achado de validação, ancorado num componente quando aplicável.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub severity: Severity,
    pub rule: String,
    pub message: String,
    #[serde(default)]
    pub component: String,
}

impl Architecture {
    fn get(&self, id: &str) -> Option<&Component> {
        self.components.iter().find(|c| c.id == id)
    }

    /// Corre as regras de validação da arquitectura, mais graves primeiro.
    pub fn validate(&self) -> Vec<Finding> {
        let mut out = Vec::new();

        // Referências de arestas têm de existir.
        for c in &self.connections {
            if self.get(&c.from).is_none() {
                out.push(Finding {
                    severity: Severity::Error,
                    rule: "dangling-edge".into(),
                    message: format!("connection from unknown component `{}`", c.from),
                    component: c.from.clone(),
                });
            }
            if self.get(&c.to).is_none() {
                out.push(Finding {
                    severity: Severity::Error,
                    rule: "dangling-edge".into(),
                    message: format!("connection to unknown component `{}`", c.to),
                    component: c.to.clone(),
                });
            }
        }

        // Outbox sem relay: uma store de outbox tem de ser LIDA por um relay que publica.
        for store in self.components.iter().filter(|c| c.kind == Kind::Store && c.outbox) {
            let relayed = self.connections.iter().any(|c| {
                c.to == store.id
                    && c.relation == Relation::Reads
                    && self.get(&c.from).map(|r| r.kind == Kind::Relay).unwrap_or(false)
            });
            if !relayed {
                out.push(Finding {
                    severity: Severity::Error,
                    rule: "outbox-without-relay".into(),
                    message: format!("outbox store `{}` is not read by any relay — events will never publish", store.name),
                    component: store.id.clone(),
                });
            }
        }

        // Eventos publicados vs consumidos (por nome de evento).
        let published: std::collections::HashSet<&str> = self
            .connections
            .iter()
            .filter(|c| c.relation == Relation::Publishes && !c.event.is_empty())
            .map(|c| c.event.as_str())
            .collect();
        let consumed: std::collections::HashSet<&str> = self
            .connections
            .iter()
            .filter(|c| c.relation == Relation::Consumes && !c.event.is_empty())
            .map(|c| c.event.as_str())
            .collect();

        for ev in &published {
            if !consumed.contains(ev) {
                out.push(Finding {
                    severity: Severity::Warning,
                    rule: "orphan-event".into(),
                    message: format!("event `{ev}` is published but no consumer subscribes to it"),
                    component: String::new(),
                });
            }
        }
        for ev in &consumed {
            if !published.contains(ev) {
                out.push(Finding {
                    severity: Severity::Error,
                    rule: "orphan-subscription".into(),
                    message: format!("event `{ev}` is consumed but nothing publishes it (orphan routing key)"),
                    component: String::new(),
                });
            }
        }

        // Broker pendurado: sem produtores ou sem consumidores.
        for broker in self.components.iter().filter(|c| c.kind == Kind::Broker) {
            let has_pub = self.connections.iter().any(|c| c.to == broker.id && c.relation == Relation::Publishes);
            let has_sub = self.connections.iter().any(|c| c.from == broker.id || (c.to == broker.id && c.relation == Relation::Consumes));
            if !has_pub || !has_sub {
                out.push(Finding {
                    severity: Severity::Warning,
                    rule: "dangling-broker".into(),
                    message: format!("broker `{}` has {}", broker.name, if !has_pub { "no producers" } else { "no consumers" }),
                    component: broker.id.clone(),
                });
            }
        }

        out.sort_by_key(|f| match f.severity {
            Severity::Error => 0,
            Severity::Warning => 1,
        });
        out
    }

    /// `true` quando não há erros (avisos são aceitáveis).
    pub fn is_valid(&self) -> bool {
        !self.validate().iter().any(|f| f.severity == Severity::Error)
    }

    /// Esqueleto do projecto a partir do desenho: uma pasta por componente «vivo»
    /// (service/consumer/relay/gateway) com um stub, e um `ARCHITECTURE.md` com o fluxo de
    /// eventos. Devolve (caminho relativo → conteúdo). Vazio se a arquitectura tem erros.
    pub fn scaffold(&self) -> Vec<(String, String)> {
        if !self.is_valid() {
            return Vec::new();
        }
        let slug = |s: &str| s.chars().map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect::<String>();
        let mut out = Vec::new();

        for c in &self.components {
            let dir = match c.kind {
                Kind::Service | Kind::Gateway => "services",
                Kind::Consumer => "consumers",
                Kind::Relay => "relays",
                _ => continue, // stores/brokers são infra, não geram pasta de código
            };
            let name = slug(&c.id);
            let publishes: Vec<&str> = self.connections.iter()
                .filter(|cn| cn.from == c.id && cn.relation == Relation::Publishes && !cn.event.is_empty())
                .map(|cn| cn.event.as_str()).collect();
            let consumes: Vec<&str> = self.connections.iter()
                .filter(|cn| cn.from == c.id && cn.relation == Relation::Consumes && !cn.event.is_empty())
                .map(|cn| cn.event.as_str()).collect();
            let mut body = format!("// {} ({:?}) — generated from the Architecture Studio design.\n", c.name, c.kind);
            if !publishes.is_empty() {
                body.push_str(&format!("// publishes: {}\n", publishes.join(", ")));
            }
            if !consumes.is_empty() {
                body.push_str(&format!("// consumes: {}\n", consumes.join(", ")));
            }
            body.push_str("\n// TODO: implement.\n");
            out.push((format!("{dir}/{name}/README.md"), format!("# {}\n\n`{:?}` component.\n", c.name, c.kind)));
            out.push((format!("{dir}/{name}/main.rs"), body));
        }

        // ARCHITECTURE.md — o fluxo de eventos legível.
        let mut md = String::from("# Architecture\n\nGenerated from the Architecture Studio design.\n\n## Components\n\n");
        for c in &self.components {
            md.push_str(&format!("- **{}** (`{:?}`{})\n", c.name, c.kind, if c.outbox { ", outbox" } else { "" }));
        }
        md.push_str("\n## Event flow\n\n");
        for cn in &self.connections {
            let ev = if cn.event.is_empty() { String::new() } else { format!(" `{}`", cn.event) };
            md.push_str(&format!("- `{}` → `{}` ({:?}{})\n", cn.from, cn.to, cn.relation, ev));
        }
        out.push(("ARCHITECTURE.md".into(), md));

        // ── Artefactos cloud-native (F8): Dockerfile por componente vivo + compose +
        // Makefile + .env.example + manifestos Kubernetes. Tudo DERIVADO do desenho real:
        // cada live-component vira um serviço que constrói da sua pasta; cada store/broker
        // vira infra local (postgres / rabbitmq — stand-ins honestos, documentados), com a
        // ligação (DATABASE_URL / AMQP_URL) inferida das arestas writes/reads/publishes/consumes.
        let is_live = |k: Kind| matches!(k, Kind::Service | Kind::Gateway | Kind::Consumer | Kind::Relay);
        let dir_of = |k: Kind| match k {
            Kind::Service | Kind::Gateway => "services",
            Kind::Consumer => "consumers",
            Kind::Relay => "relays",
            _ => "",
        };
        // Slugs das infra-dependências (store/broker) de um componente, pelas arestas.
        let deps_of = |cid: &str, want: Kind, rels: &[Relation]| -> Vec<String> {
            self.connections
                .iter()
                .filter(|cn| cn.from == cid && rels.contains(&cn.relation))
                .filter_map(|cn| self.get(&cn.to))
                .filter(|tc| tc.kind == want)
                .map(|tc| slug(&tc.id))
                .collect()
        };
        let live: Vec<&Component> = self.components.iter().filter(|c| is_live(c.kind)).collect();

        // Dockerfile (multi-stage, não-root) por componente vivo — ponto de partida do scaffold.
        for c in &live {
            let name = slug(&c.id);
            let dir = dir_of(c.kind);
            let df = format!(
                "# {name} — generated from the Architecture Studio design (scaffold starting point).\n\
                 FROM rust:1.82-slim AS build\n\
                 WORKDIR /app\n\
                 COPY . .\n\
                 # The scaffold ships a stub; replace with your crate, then: cargo build --release\n\n\
                 FROM debian:bookworm-slim\n\
                 RUN useradd --system --uid 10001 app\n\
                 USER app\n\
                 ENV RUST_LOG=info\n\
                 CMD [\"sh\", \"-c\", \"echo '{name} (scaffold) — implement me'; sleep infinity\"]\n"
            );
            out.push((format!("{dir}/{name}/Dockerfile"), df));
        }

        // docker-compose.yml — serviços vivos + infra local, com depends_on por saúde.
        let mut compose = String::from(
            "# Generated from the Architecture Studio design. Managed infra uses local stand-ins.\n\
             name: dxtutor-app\n\nservices:\n",
        );
        for c in &live {
            let name = slug(&c.id);
            let dir = dir_of(c.kind);
            let stores = deps_of(&c.id, Kind::Store, &[Relation::Writes, Relation::Reads]);
            let brokers = deps_of(&c.id, Kind::Broker, &[Relation::Publishes, Relation::Consumes]);
            compose.push_str(&format!("  {name}:\n    build: ./{dir}/{name}\n"));
            if !stores.is_empty() || !brokers.is_empty() {
                compose.push_str("    environment:\n");
                if let Some(s) = stores.first() {
                    compose.push_str(&format!("      - DATABASE_URL=postgres://app:app@{s}:5432/app\n"));
                }
                if let Some(b) = brokers.first() {
                    compose.push_str(&format!("      - AMQP_URL=amqp://guest:guest@{b}:5672\n"));
                }
            }
            let mut deps = stores.clone();
            deps.extend(brokers.clone());
            if !deps.is_empty() {
                compose.push_str("    depends_on:\n");
                for d in &deps {
                    compose.push_str(&format!("      {d}:\n        condition: service_healthy\n"));
                }
            }
            compose.push_str("    restart: unless-stopped\n");
        }
        for c in &self.components {
            let name = slug(&c.id);
            match c.kind {
                Kind::Store => compose.push_str(&format!(
                    "  {name}:\n    image: postgres:16-alpine\n    environment:\n      - POSTGRES_USER=app\n      - POSTGRES_PASSWORD=app\n      - POSTGRES_DB=app\n    healthcheck:\n      test: [\"CMD-SHELL\", \"pg_isready -U app\"]\n      interval: 5s\n      timeout: 3s\n      retries: 12\n    restart: unless-stopped\n"
                )),
                Kind::Broker => compose.push_str(&format!(
                    "  {name}:\n    image: rabbitmq:3.13-management-alpine\n    healthcheck:\n      test: [\"CMD-SHELL\", \"rabbitmq-diagnostics -q ping\"]\n      interval: 10s\n      timeout: 5s\n      retries: 12\n    restart: unless-stopped\n"
                )),
                _ => {}
            }
        }
        out.push(("docker-compose.yml".into(), compose));

        // Makefile — RUN/Stop/logs/test sobre o compose.
        out.push((
            "Makefile".into(),
            ".PHONY: run stop logs test\n\nrun:\n\tdocker compose up --build -d\n\tdocker compose ps\n\nstop:\n\tdocker compose down\n\nlogs:\n\tdocker compose logs -f\n\ntest:\n\tcargo test\n".into(),
        ));
        out.push((
            ".env.example".into(),
            "# Copy to .env — local development values only.\nPOSTGRES_PASSWORD=app\n".into(),
        ));

        // Kubernetes: um Deployment+Service por componente vivo + um 00-infra.yaml para stores/brokers.
        for c in &live {
            let name = slug(&c.id);
            let has_store = !deps_of(&c.id, Kind::Store, &[Relation::Writes, Relation::Reads]).is_empty();
            let has_broker = !deps_of(&c.id, Kind::Broker, &[Relation::Publishes, Relation::Consumes]).is_empty();
            let mut env = String::new();
            if has_store {
                let s = &deps_of(&c.id, Kind::Store, &[Relation::Writes, Relation::Reads])[0];
                env.push_str(&format!("            - {{ name: DATABASE_URL, value: \"postgres://app:app@{s}:5432/app\" }}\n"));
            }
            if has_broker {
                let b = &deps_of(&c.id, Kind::Broker, &[Relation::Publishes, Relation::Consumes])[0];
                env.push_str(&format!("            - {{ name: AMQP_URL, value: \"amqp://guest:guest@{b}:5672\" }}\n"));
            }
            let env_block = if env.is_empty() { String::new() } else { format!("          env:\n{env}") };
            out.push((
                format!("deploy/k8s/{name}.yaml"),
                format!(
                    "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {name}\nspec:\n  replicas: 1\n  selector:\n    matchLabels: {{ app: {name} }}\n  template:\n    metadata:\n      labels: {{ app: {name} }}\n    spec:\n      containers:\n        - name: {name}\n          image: registry.example.com/{name}:0.1.0\n{env_block}          resources:\n            requests: {{ cpu: 50m, memory: 64Mi }}\n            limits: {{ cpu: 500m, memory: 256Mi }}\n          securityContext: {{ runAsNonRoot: true, allowPrivilegeEscalation: false }}\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: {name}\nspec:\n  selector: {{ app: {name} }}\n  ports: [{{ port: 80, targetPort: 8080 }}]\n"
                ),
            ));
        }
        let mut infra = String::from("# Local infra stand-ins (store/broker) for the design.\n");
        for c in &self.components {
            let name = slug(&c.id);
            let (image, port) = match c.kind {
                Kind::Store => ("postgres:16-alpine", 5432),
                Kind::Broker => ("rabbitmq:3.13-management-alpine", 5672),
                _ => continue,
            };
            infra.push_str(&format!(
                "---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {name}\nspec:\n  replicas: 1\n  selector:\n    matchLabels: {{ app: {name} }}\n  template:\n    metadata:\n      labels: {{ app: {name} }}\n    spec:\n      containers:\n        - name: {name}\n          image: {image}\n          ports: [{{ containerPort: {port} }}]\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: {name}\nspec:\n  selector: {{ app: {name} }}\n  ports: [{{ port: {port}, targetPort: {port} }}]\n"
            ));
        }
        out.push(("deploy/k8s/00-infra.yaml".into(), infra));

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comp(id: &str, kind: Kind, outbox: bool) -> Component {
        Component { id: id.into(), name: id.into(), kind, outbox }
    }
    fn conn(from: &str, to: &str, relation: Relation, event: &str) -> Connection {
        Connection { from: from.into(), to: to.into(), relation, event: event.into() }
    }

    /// The order-flow from the reference image: service → outbox → relay → broker → consumer.
    fn ok_arch() -> Architecture {
        Architecture {
            components: vec![
                comp("svc", Kind::Service, false),
                comp("db", Kind::Store, true),
                comp("relay", Kind::Relay, false),
                comp("mq", Kind::Broker, false),
                comp("worker", Kind::Consumer, false),
            ],
            connections: vec![
                conn("svc", "db", Relation::Writes, ""),
                conn("relay", "db", Relation::Reads, ""),
                conn("relay", "mq", Relation::Publishes, "order.placed"),
                conn("worker", "mq", Relation::Consumes, "order.placed"),
            ],
        }
    }

    #[test]
    fn valid_outbox_flow_passes() {
        let a = ok_arch();
        assert!(a.is_valid(), "{:?}", a.validate());
    }

    #[test]
    fn outbox_without_relay_is_an_error() {
        let mut a = ok_arch();
        a.connections.retain(|c| c.relation != Relation::Reads); // drop the relay reading the outbox
        let f = a.validate();
        assert!(f.iter().any(|x| x.rule == "outbox-without-relay" && x.severity == Severity::Error), "{f:?}");
        assert!(!a.is_valid());
    }

    #[test]
    fn orphan_subscription_and_event_are_flagged() {
        let mut a = ok_arch();
        // Consumer now subscribes to an event nobody publishes.
        for c in a.connections.iter_mut() {
            if c.relation == Relation::Consumes {
                c.event = "order.cancelled".into();
            }
        }
        let f = a.validate();
        assert!(f.iter().any(|x| x.rule == "orphan-subscription"), "{f:?}"); // nothing publishes order.cancelled
        assert!(f.iter().any(|x| x.rule == "orphan-event"), "{f:?}"); // order.placed now has no consumer
    }

    #[test]
    fn scaffold_emits_folders_and_architecture_md() {
        let files = ok_arch().scaffold();
        let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
        assert!(paths.contains(&"services/svc/main.rs"), "{paths:?}");
        assert!(paths.contains(&"relays/relay/main.rs"), "{paths:?}");
        assert!(paths.contains(&"consumers/worker/main.rs"), "{paths:?}");
        assert!(paths.contains(&"ARCHITECTURE.md"), "{paths:?}");
        // No code folder for infra (store/broker).
        assert!(!paths.iter().any(|p| p.contains("/db/") || p.contains("/mq/")), "{paths:?}");
        // The relay's stub names the event it publishes.
        let relay = files.iter().find(|(p, _)| p == "relays/relay/main.rs").unwrap();
        assert!(relay.1.contains("order.placed"), "{}", relay.1);
    }

    #[test]
    fn scaffold_emits_cloud_native_artifacts() {
        let files = ok_arch().scaffold();
        let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
        // A Dockerfile per live component (service/relay/consumer/gateway).
        assert!(paths.contains(&"services/svc/Dockerfile"), "{paths:?}");
        assert!(paths.contains(&"relays/relay/Dockerfile"), "{paths:?}");
        assert!(paths.contains(&"consumers/worker/Dockerfile"), "{paths:?}");
        // Root artefacts.
        assert!(paths.contains(&"docker-compose.yml"), "{paths:?}");
        assert!(paths.contains(&"Makefile"), "{paths:?}");
        assert!(paths.contains(&".env.example"), "{paths:?}");
        // Kubernetes: one manifest per live component plus the infra bundle.
        assert!(paths.contains(&"deploy/k8s/svc.yaml"), "{paths:?}");
        assert!(paths.contains(&"deploy/k8s/00-infra.yaml"), "{paths:?}");
        // Compose declares the store+broker as local infra and wires the live services.
        let compose = &files.iter().find(|(p, _)| p == "docker-compose.yml").unwrap().1;
        assert!(compose.contains("postgres") && compose.contains("db:"), "{compose}");
        assert!(compose.contains("rabbitmq") && compose.contains("mq:"), "{compose}");
        assert!(compose.contains("build: ./services/svc"), "{compose}");
        // worker consumes the broker and relay publishes to it → AMQP_URL wired.
        assert!(compose.contains("AMQP_URL"), "{compose}");
        // Dockerfiles are multi-stage and run as non-root (review heuristics).
        let df = &files.iter().find(|(p, _)| p == "services/svc/Dockerfile").unwrap().1;
        assert!(df.contains(" AS build") && df.contains("USER "), "{df}");
        // Infra (store/broker) still gets no code folder.
        assert!(!paths.iter().any(|p| p.contains("/db/") || p.contains("/mq/")), "{paths:?}");
    }

    #[test]
    fn scaffold_refuses_an_invalid_design() {
        let mut a = ok_arch();
        a.connections.retain(|c| c.relation != Relation::Reads); // outbox-without-relay = error
        assert!(a.scaffold().is_empty());
    }

    #[test]
    fn dangling_edge_is_an_error() {
        let a = Architecture {
            components: vec![comp("a", Kind::Service, false)],
            connections: vec![conn("a", "ghost", Relation::Writes, "")],
        };
        assert!(a.validate().iter().any(|x| x.rule == "dangling-edge"));
    }
}
