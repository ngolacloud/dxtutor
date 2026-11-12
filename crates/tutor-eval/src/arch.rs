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
