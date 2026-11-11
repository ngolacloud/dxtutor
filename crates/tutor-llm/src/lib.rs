//! `tutor-llm` — a camada de **dicas pedagógicas** do dxtutor.
//!
//! Esta crate NUNCA julga a correcção do código e NUNCA revela a solução
//! completa do gabarito. Quem decide se o código está certo são os testes
//! (`cargo test`, em `tutor-eval`); a complexidade de referência é curada no
//! gabarito. Aqui só se produzem **dicas progressivas** que orientam o
//! raciocínio do aluno quando ele encrava — o princípio de honestidade do
//! produto é sagrado.
//!
//! O contrato é o trait [`HintProvider`]. Há duas implementações:
//!
//! * [`OfflineProvider`] — não contacta rede nenhuma; explica como ligar as
//!   dicas por LLM e dá, mesmo assim, uma pista genérica útil.
//! * [`ClaudeProvider`] — fala com a Messages API da Anthropic (modelo Haiku
//!   4.5 por omissão) via HTTP bloqueante (`ureq`). Trata erros de rede/parse
//!   de forma legível — nunca entra em pânico.
//!
//! Use [`default_provider`] para obter o provider certo conforme o ambiente.

use anyhow::{anyhow, Result};

/// Local Dev-Assistant chat (Ollama). Separate from the pedagogical hint providers.
pub mod chat;

/// Modelo por omissão: Haiku 4.5 — barato e rápido, ideal para dicas curtas.
/// (ID exacto confirmado via a skill `claude-api`.)
pub const DEFAULT_MODEL: &str = "claude-haiku-4-5";

/// Variável de ambiente com a chave da API Anthropic.
pub const API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
/// Variável de ambiente opcional para escolher outro modelo de dicas.
pub const MODEL_ENV: &str = "DXTUTOR_HINT_MODEL";

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 400;

/// Pedido de dica: o contexto pedagógico de uma fase mais o código actual do
/// aluno e (se houver) a saída dos testes falhados.
#[derive(Debug, Clone)]
pub struct HintRequest {
    /// Instruções da fase (o que é preciso fazer).
    pub instructions: String,
    /// Nome da função que o aluno tem de implementar (ponto de entrada).
    pub entry: String,
    /// Código que o aluno escreveu até agora.
    pub student_code: String,
    /// Saída dos testes falhados, se a última avaliação não passou.
    pub test_output: Option<String>,
    /// Nível da dica, de 1 (mais geral) a 3 (mais concreta). Fora da gama é
    /// fixado em `1..=3`.
    pub level: u8,
}

impl HintRequest {
    /// Nível normalizado para a gama `1..=3`.
    pub fn level(&self) -> u8 {
        self.level.clamp(1, 3)
    }

    /// Monta a mensagem do utilizador enviada ao modelo. É também o ponto onde
    /// se prova, nos testes, que os campos do pedido são bem formatados.
    pub fn user_prompt(&self) -> String {
        let nivel = match self.level() {
            1 => "nível 1 (a mais geral: aponta o conceito ou a estratégia, sem estrutura)",
            2 => "nível 2 (intermédia: sugere a estrutura ou os passos, sem escrever código)",
            _ => "nível 3 (a mais concreta: uma pista específica sobre o próximo passo)",
        };

        let mut s = String::new();
        s.push_str(&format!("Dá-me uma dica de {nivel}.\n\n"));
        s.push_str(&format!("## Função a implementar\n`{}`\n\n", self.entry));
        s.push_str("## Instruções da fase\n");
        s.push_str(self.instructions.trim());
        s.push_str("\n\n## O meu código actual\n```rust\n");
        s.push_str(self.student_code.trim());
        s.push_str("\n```\n");

        if let Some(out) = &self.test_output {
            let out = out.trim();
            if !out.is_empty() {
                s.push_str("\n## Saída dos testes (falharam)\n```\n");
                s.push_str(truncate(out, 2000));
                s.push_str("\n```\n");
            }
        }
        s
    }
}

/// Contrato de uma fonte de dicas. É `Send + Sync` para poder correr numa
/// thread de fundo (a TUI é síncrona e nunca bloqueia à espera da rede).
pub trait HintProvider: Send + Sync {
    /// Produz uma dica para o pedido dado. Nunca entra em pânico; falhas de
    /// rede/parse voltam como `Err` legível.
    fn hint(&self, req: &HintRequest) -> Result<String>;

    /// Nome curto do provider (sobretudo para diagnóstico e testes).
    fn name(&self) -> &'static str {
        "provider"
    }
}

/// Provider sem rede: usado quando não há `ANTHROPIC_API_KEY`. Explica como
/// activar as dicas por LLM e dá, mesmo assim, uma pista genérica útil.
#[derive(Debug, Default, Clone)]
pub struct OfflineProvider;

impl HintProvider for OfflineProvider {
    fn hint(&self, req: &HintRequest) -> Result<String> {
        Ok(format!(
            "As dicas por LLM estão indisponíveis (não está definida a variável \
             de ambiente `{API_KEY_ENV}`). Define-a para as activar — \
             opcionalmente escolhe o modelo com `{MODEL_ENV}`.\n\n\
             Entretanto, uma pista genérica (nível {}): relê com calma as \
             instruções da fase, isola o que `{}` tem de devolver, e começa \
             pelos casos mais simples dos testes antes de pensar no caso geral.",
            req.level(),
            req.entry,
        ))
    }

    fn name(&self) -> &'static str {
        "offline"
    }
}

/// Provider que fala com a Messages API da Anthropic.
#[derive(Debug, Clone)]
pub struct ClaudeProvider {
    pub api_key: String,
    pub model: String,
}

impl ClaudeProvider {
    /// Constrói o provider a partir do ambiente, lendo [`API_KEY_ENV`] e,
    /// opcionalmente, [`MODEL_ENV`] (senão, [`DEFAULT_MODEL`]). Devolve `None`
    /// se não houver chave.
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var(API_KEY_ENV).ok().filter(|k| !k.trim().is_empty())?;
        let model = std::env::var(MODEL_ENV)
            .ok()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        Some(ClaudeProvider { api_key, model })
    }

    /// Helper HTTP partilhado pelas três capacidades (dica/plano/correcção):
    /// envia um par `system`/`user` à Messages API e devolve o texto. Nunca
    /// entra em pânico; falhas de rede/parse/estado voltam como `Err` legível.
    fn call(&self, system: String, user: String) -> Result<String> {
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "system": system,
            "messages": [
                { "role": "user", "content": user }
            ],
        });

        let resp = ureq::post(ENDPOINT)
            .set("x-api-key", &self.api_key)
            .set("anthropic-version", ANTHROPIC_VERSION)
            .set("content-type", "application/json")
            .send_json(body);

        match resp {
            Ok(r) => {
                let v: serde_json::Value = r
                    .into_json()
                    .map_err(|e| anyhow!("resposta ilegível da API: {e}"))?;
                extract_text(&v)
            }
            Err(ureq::Error::Status(code, r)) => {
                let detail = r.into_string().unwrap_or_default();
                Err(anyhow!(
                    "a API devolveu HTTP {code}: {}",
                    truncate(detail.trim(), 300)
                ))
            }
            Err(ureq::Error::Transport(t)) => {
                Err(anyhow!("falha de rede ao contactar a API: {t}"))
            }
        }
    }
}

/// O system prompt do tutor: pedagógico, em pt-AO pré-AO90, dicas curtas e
/// progressivas, sem revelar a solução e deixando claro quem decide a
/// correcção (os testes).
fn system_prompt() -> String {
    "És um tutor pedagógico de programação Rust dentro do dxtutor. Respondes \
     SEMPRE em português de Angola (pt-AO), ortografia pré-AO90 («acção», \
     «correcção», «óptimo», «directo», «facto»).\n\n\
     A tua ÚNICA tarefa é dar dicas CURTAS e PROGRESSIVAS que orientem o \
     raciocínio do aluno conforme o nível pedido:\n\
     - nível 1: aponta apenas o conceito ou a estratégia geral;\n\
     - nível 2: sugere a estrutura ou os passos, sem escrever código;\n\
     - nível 3: dá uma pista concreta sobre o próximo passo, ainda sem a \
     solução completa.\n\n\
     REGRAS INVIOLÁVEIS:\n\
     - NUNCA escreves a solução final nem o corpo completo da função.\n\
     - NUNCA afirmas que o código do aluno está «certo» ou «errado»: quem \
     decide a correcção são os testes (`cargo test`), não tu.\n\
     - NUNCA reveles nem adivinhes a complexidade de referência como se fosse \
     verdade provada — isso é curado no gabarito.\n\
     - Sê breve (poucas frases), encorajador e específico ao código do aluno.\n\
     - Se o aluno já parece perto, orienta o detalhe que falta sem o entregar."
        .to_string()
}

impl HintProvider for ClaudeProvider {
    fn hint(&self, req: &HintRequest) -> Result<String> {
        self.call(system_prompt(), req.user_prompt())
    }

    fn name(&self) -> &'static str {
        "claude"
    }
}

// ===========================================================================
// Capacidade 2: PLANO a partir de comentário (comentário -> plano conceptual).
//
// O aluno lê o plano e ESCREVE ele o código ("muscular o cérebro"). O produto
// é em INGLÊS, por isso os passos devolvidos ao aluno são em inglês. O plano é
// SEMPRE conceptual: NUNCA blocos de código nem pseudo-código copiável.
// ===========================================================================

/// Pedido de plano: um comentário a descrever o que o próximo pedaço de código
/// deve fazer, mais o código à volta (só para contexto — nunca para completar).
#[derive(Debug, Clone)]
pub struct PlanRequest {
    /// Linguagem do exercício (ex.: `"rust"`), usada para contextualizar.
    pub language: String,
    /// Comentário que descreve o objectivo do código a escrever.
    pub comment: String,
    /// Código à volta, só para contexto. Pode estar vazio.
    pub context_code: String,
}

impl PlanRequest {
    /// Mensagem do utilizador enviada ao modelo. O código de contexto entra
    /// como ENTRADA (num bloco), mas o modelo é instruído a NÃO o completar.
    pub fn user_prompt(&self) -> String {
        let lang = self.language.trim();
        let lang = if lang.is_empty() { "code" } else { lang };
        let mut s = String::new();
        s.push_str(&format!("Language: {lang}\n\n"));
        s.push_str("Here is the comment describing what the next piece of code should do:\n");
        s.push_str(self.comment.trim());
        s.push('\n');

        let ctx = self.context_code.trim();
        if !ctx.is_empty() {
            s.push_str("\n## Surrounding code (context only — do NOT complete it)\n```");
            s.push_str(lang);
            s.push('\n');
            s.push_str(truncate(ctx, 2000));
            s.push_str("\n```\n");
        }
        s.push_str(
            "\nGive me a SHORT, high-level plan (a few conceptual steps) that I can \
             follow to write the code MYSELF. No code.",
        );
        s
    }
}

/// Um plano: uma lista CURTA de passos conceptuais de alto nível, em inglês,
/// sem código.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Passos de alto nível, por ordem. Cada passo é uma frase conceptual.
    pub steps: Vec<String>,
}

/// Contrato de uma fonte de planos. `Send + Sync` para correr numa thread de
/// fundo, tal como [`HintProvider`].
pub trait PlanProvider: Send + Sync {
    /// Produz um plano conceptual (sem código) para o pedido dado. Nunca entra
    /// em pânico; falhas voltam como `Err` legível.
    fn plan(&self, req: &PlanRequest) -> Result<Plan>;
}

/// System prompt do plano. Em inglês (o produto é EN) e PROÍBE explicitamente
/// blocos de código e soluções literais.
fn plan_system_prompt() -> String {
    "You are a programming tutor inside dxtutor. The student will WRITE the code \
     themselves — your job is to help them think, never to write it for them.\n\n\
     Given a short comment describing what a piece of code should do, produce a \
     SHORT plan: 3 to 6 high-level, CONCEPTUAL steps describing the approach.\n\n\
     INVIOLABLE RULES:\n\
     - NEVER output code or pseudo-code that can be copied.\n\
     - NEVER write the literal solution or the body of any function.\n\
     - Each step is a conceptual action in plain English (e.g. 'parse the input', \
     'count occurrences with a hash map', 'sort by frequency'), not a line of code.\n\
     - Do NOT say whether existing code is correct or wrong — the tests decide that.\n\
     - Do NOT claim any time/space complexity as proven fact.\n\
     - Keep each step to one short sentence.\n\
     - Output ONLY the list, one step per line, no code fences."
        .to_string()
}

/// Divide o texto do modelo em passos, descartando linhas vazias e QUALQUER
/// linha com cerca de código (```), e tirando marcadores de lista/numeração.
/// É a barreira que garante a honestidade do plano mesmo que o modelo
/// desobedeça e envie código.
fn parse_plan(text: &str) -> Plan {
    let mut steps = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        let line = line.trim();
        // Uma cerca abre/fecha um bloco; tudo lá dentro (código) é descartado.
        if line.contains("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || line.is_empty() {
            continue;
        }
        let cleaned = line
            .trim_start_matches(|c: char| {
                c.is_ascii_digit() || matches!(c, '.' | ')' | '-' | '*' | '•' | ' ' | '\t')
            })
            .trim();
        if !cleaned.is_empty() {
            steps.push(cleaned.to_string());
        }
    }
    Plan { steps }
}

impl PlanProvider for OfflineProvider {
    fn plan(&self, _req: &PlanRequest) -> Result<Plan> {
        // Plano genérico mas útil, em inglês e sem código. Serve de andaime
        // quando não há LLM: reler o objectivo, decompor, começar pelos testes.
        Ok(Plan {
            steps: vec![
                "Re-read the comment and restate the goal in your own words.".into(),
                "Identify the exact inputs and the output you must produce.".into(),
                "Break the problem into the smallest steps; start from the simplest test case."
                    .into(),
                "Pick a data structure that fits the data before writing any code.".into(),
                "Write the code yourself one step at a time, running the tests often.".into(),
            ],
        })
    }
}

impl PlanProvider for ClaudeProvider {
    fn plan(&self, req: &PlanRequest) -> Result<Plan> {
        let text = self.call(plan_system_prompt(), req.user_prompt())?;
        let plan = parse_plan(&text);
        if plan.steps.is_empty() {
            return Err(anyhow!("o plano devolvido não continha passos utilizáveis"));
        }
        Ok(plan)
    }
}

// ===========================================================================
// Capacidade 3: SUGESTÃO DE CORRECÇÃO para um diagnóstico numa linha.
//
// A futura "linha vermelha + correcção acima": explica, em inglês, o que está
// errado NAQUELA linha e como corrigir CONCEITUALMENTE. Pode indicar a
// correcção mínima, mas NUNCA reescreve a função nem resolve o desafio.
// ===========================================================================

/// Pedido de sugestão de correcção para um diagnóstico localizado.
#[derive(Debug, Clone)]
pub struct FixRequest {
    /// Linguagem do exercício (ex.: `"rust"`).
    pub language: String,
    /// Código do aluno (ou o excerto relevante).
    pub code: String,
    /// Linha (base 1) onde o diagnóstico foi reportado.
    pub line: u32,
    /// Mensagem do diagnóstico (ex.: a mensagem do compilador).
    pub message: String,
}

impl FixRequest {
    /// Mensagem do utilizador enviada ao modelo.
    pub fn user_prompt(&self) -> String {
        let lang = self.language.trim();
        let lang = if lang.is_empty() { "code" } else { lang };
        let mut s = String::new();
        s.push_str(&format!("Language: {lang}\n\n"));
        s.push_str(&format!(
            "A diagnostic was reported on line {}: {}\n",
            self.line,
            self.message.trim()
        ));
        s.push_str("\n## Code\n```");
        s.push_str(lang);
        s.push('\n');
        s.push_str(truncate(self.code.trim(), 2000));
        s.push_str("\n```\n");
        s.push_str(&format!(
            "\nExplain briefly what is wrong on line {} and how to fix it \
             conceptually, WITHOUT solving the whole exercise.",
            self.line
        ));
        s
    }
}

/// Contrato de uma fonte de sugestões de correcção. `Send + Sync`.
pub trait FixProvider: Send + Sync {
    /// Explica CURTAMENTE, em inglês, o que está errado na linha e como
    /// corrigir — sem reescrever a função nem resolver o desafio. Nunca entra
    /// em pânico; falhas voltam como `Err` legível.
    fn fix_suggestion(&self, req: &FixRequest) -> Result<String>;
}

/// System prompt da correcção. Em inglês; foca-se SÓ no erro desta linha e
/// proíbe resolver o exercício.
fn fix_system_prompt() -> String {
    "You are a programming tutor inside dxtutor. A diagnostic was reported on a \
     SPECIFIC line of the student's code.\n\n\
     Explain BRIEFLY, in English, what is wrong on THAT line and how to fix it \
     conceptually. You MAY name the minimal fix needed (e.g. 'add a semicolon', \
     'borrow with &', 'the value was moved earlier'), but you MUST NOT rewrite \
     the whole function or solve the exercise for the student.\n\n\
     INVIOLABLE RULES:\n\
     - Focus ONLY on the error on this line; ignore the rest of the challenge.\n\
     - NEVER provide the full solution or a complete function body.\n\
     - NEVER say the overall code is 'correct' or 'wrong' — the tests decide that.\n\
     - Two or three sentences at most."
        .to_string()
}

impl FixProvider for OfflineProvider {
    fn fix_suggestion(&self, req: &FixRequest) -> Result<String> {
        // Sem LLM, devolve uma sugestão útil e honesta, focada na linha, em
        // inglês, sem resolver o exercício.
        Ok(format!(
            "LLM fix suggestions are unavailable (set `{API_KEY_ENV}` to enable them). \
             For now, focus on line {}: the diagnostic says \"{}\". Re-read only that \
             line, check the types, borrows and punctuation it points at, and change \
             the smallest thing needed — don't rewrite the whole function.",
            req.line,
            req.message.trim(),
        ))
    }
}

impl FixProvider for ClaudeProvider {
    fn fix_suggestion(&self, req: &FixRequest) -> Result<String> {
        self.call(fix_system_prompt(), req.user_prompt())
    }
}

/// Extrai o texto da resposta da Messages API, tratando recusas e respostas
/// vazias de forma legível.
fn extract_text(v: &serde_json::Value) -> Result<String> {
    // Erro no envelope (ex.: `{"type":"error","error":{"message":...}}`).
    if v.get("type").and_then(|t| t.as_str()) == Some("error") {
        let msg = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("erro desconhecido");
        return Err(anyhow!("a API de dicas recusou o pedido: {msg}"));
    }

    let blocks = v
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| anyhow!("resposta da API sem bloco `content`"))?;

    let mut out = String::new();
    for b in blocks {
        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                out.push_str(t);
            }
        }
    }
    let out = out.trim();
    if out.is_empty() {
        let stop = v.get("stop_reason").and_then(|s| s.as_str()).unwrap_or("?");
        return Err(anyhow!(
            "a API de dicas não devolveu texto (stop_reason: {stop})"
        ));
    }
    Ok(out.to_string())
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Escolhe o provider a partir do ambiente: [`ClaudeProvider`] se houver chave,
/// senão [`OfflineProvider`]. Tudo compila e corre sem `ANTHROPIC_API_KEY`.
pub fn default_provider() -> Box<dyn HintProvider> {
    match ClaudeProvider::from_env() {
        Some(p) => Box::new(p),
        None => Box::new(OfflineProvider),
    }
}

/// Escolhe o provider de PLANOS a partir do ambiente: [`ClaudeProvider`] se
/// houver chave, senão [`OfflineProvider`]. Tudo corre sem `ANTHROPIC_API_KEY`.
pub fn default_plan_provider() -> Box<dyn PlanProvider> {
    match ClaudeProvider::from_env() {
        Some(p) => Box::new(p),
        None => Box::new(OfflineProvider),
    }
}

/// Escolhe o provider de CORRECÇÕES a partir do ambiente: [`ClaudeProvider`] se
/// houver chave, senão [`OfflineProvider`]. Tudo corre sem `ANTHROPIC_API_KEY`.
pub fn default_fix_provider() -> Box<dyn FixProvider> {
    match ClaudeProvider::from_env() {
        Some(p) => Box::new(p),
        None => Box::new(OfflineProvider),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn req(level: u8) -> HintRequest {
        HintRequest {
            instructions: "Conta a frequência de cada palavra.".into(),
            entry: "count_frequencies".into(),
            student_code: "fn count_frequencies() {}".into(),
            test_output: Some("thread panicked: assertion failed".into()),
            level,
        }
    }

    /// Provider fake em memória: prova o contrato do trait sem tocar na rede.
    /// Guarda o último pedido para se verificar a formatação.
    #[derive(Default)]
    struct FakeProvider {
        last: Mutex<Option<HintRequest>>,
    }

    impl HintProvider for FakeProvider {
        fn hint(&self, req: &HintRequest) -> Result<String> {
            *self.last.lock().unwrap() = Some(req.clone());
            Ok(format!("Pista fake (nível {})", req.level()))
        }
        fn name(&self) -> &'static str {
            "fake"
        }
    }

    #[test]
    fn contrato_do_trait_e_formatacao_do_pedido() {
        let fake = FakeProvider::default();
        // Usamos o trait object para provar que o contrato chega como esperado.
        let p: &dyn HintProvider = &fake;
        let out = p.hint(&req(2)).expect("fake nunca falha");
        assert_eq!(out, "Pista fake (nível 2)");

        let captured = fake.last.lock().unwrap().clone().expect("pedido guardado");
        let prompt = captured.user_prompt();
        assert!(prompt.contains("count_frequencies"), "entry em falta no prompt");
        assert!(prompt.contains("Conta a frequência"), "instruções em falta");
        assert!(prompt.contains("fn count_frequencies()"), "código do aluno em falta");
        assert!(prompt.contains("assertion failed"), "saída dos testes em falta");
        assert!(prompt.contains("nível 2"), "nível em falta no prompt");
    }

    #[test]
    fn nivel_e_fixado_na_gama() {
        assert_eq!(req(0).level(), 1);
        assert_eq!(req(2).level(), 2);
        assert_eq!(req(9).level(), 3);
    }

    #[test]
    fn prompt_omite_seccao_de_testes_quando_nao_ha() {
        let mut r = req(1);
        r.test_output = None;
        let prompt = r.user_prompt();
        assert!(!prompt.contains("Saída dos testes"), "não devia haver secção de testes");
    }

    #[test]
    fn offline_da_mensagem_util_e_menciona_a_chave() {
        let p = OfflineProvider;
        let out = p.hint(&req(1)).expect("offline nunca falha");
        assert!(out.contains(API_KEY_ENV), "devia explicar a variável de ambiente");
        assert!(out.contains("instruções"), "devia dar uma pista genérica");
        assert_eq!(p.name(), "offline");
    }

    // Um único teste a mexer no ambiente global: os sub-casos correm em
    // sequência para não haver corrida entre threads de teste (edição 2021:
    // `remove_var`/`set_var` são seguros).
    #[test]
    fn seleccao_de_provider_pelo_ambiente() {
        let prev_key = std::env::var(API_KEY_ENV).ok();
        let prev_model = std::env::var(MODEL_ENV).ok();

        // 1. Sem chave → Offline.
        std::env::remove_var(API_KEY_ENV);
        std::env::remove_var(MODEL_ENV);
        assert!(ClaudeProvider::from_env().is_none(), "sem chave não há ClaudeProvider");
        assert_eq!(
            default_provider().name(),
            "offline",
            "sem ANTHROPIC_API_KEY, default_provider() devolve Offline"
        );

        // 2. Com chave e sem override → ClaudeProvider com o modelo por omissão.
        std::env::set_var(API_KEY_ENV, "sk-teste-nao-usada");
        let p = ClaudeProvider::from_env().expect("com chave há provider");
        assert_eq!(p.model, DEFAULT_MODEL, "sem override usa o modelo por omissão");
        assert_eq!(p.name(), "claude");
        assert_eq!(default_provider().name(), "claude");

        // 3. Override do modelo é respeitado.
        std::env::set_var(MODEL_ENV, "claude-opus-4-8");
        let p2 = ClaudeProvider::from_env().expect("com chave há provider");
        assert_eq!(p2.model, "claude-opus-4-8", "deve respeitar o override do modelo");

        // Restaura o ambiente.
        match prev_key {
            Some(k) => std::env::set_var(API_KEY_ENV, k),
            None => std::env::remove_var(API_KEY_ENV),
        }
        match prev_model {
            Some(m) => std::env::set_var(MODEL_ENV, m),
            None => std::env::remove_var(MODEL_ENV),
        }
    }

    // --- Capacidade 2: PLANO (offline-safe, sem rede) -------------------

    fn plan_req() -> PlanRequest {
        PlanRequest {
            language: "rust".into(),
            comment: "count the frequency of each word in the input".into(),
            context_code: "fn count_frequencies(input: &str) -> Vec<(String, usize)> {".into(),
        }
    }

    /// Fake de plano: prova o contrato do trait sem tocar na rede.
    #[derive(Default)]
    struct FakePlanProvider;
    impl PlanProvider for FakePlanProvider {
        fn plan(&self, _req: &PlanRequest) -> Result<Plan> {
            Ok(Plan {
                steps: vec!["parse the input".into(), "count with a hash map".into()],
            })
        }
    }

    #[test]
    fn plano_offline_tem_passos_sem_codigo() {
        let p = OfflineProvider;
        let plan = p.plan(&plan_req()).expect("offline nunca falha");
        assert!(!plan.steps.is_empty(), "o plano devia ter passos");

        let joined = plan.steps.join("\n");
        // Honestidade: nenhum bloco de código.
        assert!(!joined.contains("```"), "o plano não pode conter blocos de código");
        // Não despeja o corpo da função-solução: não repete a assinatura dada.
        assert!(
            !joined.contains("fn count_frequencies"),
            "o plano não pode conter o corpo/assinatura da solução"
        );
    }

    #[test]
    fn plano_fake_respeita_o_contrato() {
        let p: &dyn PlanProvider = &FakePlanProvider;
        let plan = p.plan(&plan_req()).expect("fake nunca falha");
        assert_eq!(plan.steps.len(), 2);
        assert!(!plan.steps.join("\n").contains("```"));
    }

    /// A barreira `parse_plan` descarta código mesmo que o modelo desobedeça —
    /// é isto que garante a honestidade no caminho do ClaudeProvider.
    #[test]
    fn parse_plan_descarta_blocos_de_codigo() {
        let modelo = "1. parse the input\n\
                      ```rust\n\
                      fn count_frequencies(input: &str) { todo!() }\n\
                      ```\n\
                      - use a hash map to count\n\
                      * sort by frequency\n";
        let plan = parse_plan(modelo);
        let joined = plan.steps.join("\n");
        assert!(!joined.contains("```"), "fences não podem passar");
        assert!(!joined.contains("fn count_frequencies"), "código não pode passar");
        assert!(plan.steps.iter().any(|s| s == "parse the input"), "passo limpo de numeração");
        assert!(plan.steps.iter().any(|s| s == "use a hash map to count"), "passo limpo de bullet");
    }

    // --- Capacidade 3: CORRECÇÃO (offline-safe, sem rede) ---------------

    fn fix_req() -> FixRequest {
        FixRequest {
            language: "rust".into(),
            code: "let x = 1\nprintln!(\"{x}\");".into(),
            line: 1,
            message: "expected `;`, found `println`".into(),
        }
    }

    /// Fake de correcção: prova o contrato do trait sem tocar na rede.
    #[derive(Default)]
    struct FakeFixProvider;
    impl FixProvider for FakeFixProvider {
        fn fix_suggestion(&self, req: &FixRequest) -> Result<String> {
            Ok(format!("line {}: add a semicolon", req.line))
        }
    }

    #[test]
    fn correccao_offline_nao_vazia_e_focada_na_linha() {
        let p = OfflineProvider;
        let out = p.fix_suggestion(&fix_req()).expect("offline nunca falha");
        assert!(!out.trim().is_empty(), "a sugestão não pode ser vazia");
        assert!(out.contains("line 1"), "devia referir a linha do diagnóstico");
        assert!(out.contains(API_KEY_ENV), "devia explicar como activar o LLM");
        // Honestidade: não resolve o exercício com um bloco de código.
        assert!(!out.contains("```"), "a correcção não pode despejar código");
    }

    #[test]
    fn correccao_fake_respeita_o_contrato() {
        let p: &dyn FixProvider = &FakeFixProvider;
        let out = p.fix_suggestion(&fix_req()).expect("fake nunca falha");
        assert_eq!(out, "line 1: add a semicolon");
    }

    #[test]
    fn user_prompts_novos_formatam_os_campos() {
        let pp = plan_req().user_prompt();
        assert!(pp.contains("count the frequency"), "comentário no prompt do plano");
        assert!(pp.contains("Language: rust"), "linguagem no prompt do plano");

        let fp = fix_req().user_prompt();
        assert!(fp.contains("line 1"), "linha no prompt da correcção");
        assert!(fp.contains("expected `;`"), "mensagem no prompt da correcção");
    }

    #[test]
    fn system_prompts_novos_proibem_codigo_e_solucao() {
        let plan_sp = plan_system_prompt();
        assert!(plan_sp.contains("NEVER output code"), "plano proíbe código");
        assert!(plan_sp.contains("no code fences"), "plano proíbe fences");

        let fix_sp = fix_system_prompt();
        assert!(fix_sp.contains("Focus ONLY on the error on this line"), "fix foca-se na linha");
        assert!(fix_sp.contains("MUST NOT rewrite the whole function"), "fix não reescreve tudo");
    }
}
