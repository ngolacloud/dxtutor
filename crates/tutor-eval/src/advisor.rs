//! Conselheiro **interno** — a inteligência do dxtutor sem IA externa.
//!
//! As mensagens do compilador (rustc) e do motor JS são muito estruturadas. Em
//! vez de precisar de um modelo de linguagem para sugerir uma correcção, mapeamos
//! padrões conhecidos dessas mensagens para uma dica **accionável**, em inglês
//! (a UI do produto é EN), gerada 100% offline. Honestidade: isto explica o erro
//! e aponta a correcção típica; NÃO afirma que o resto do código está certo (isso
//! é dos testes) nem resolve o exercício pelo aluno.
//!
//! A camada de LLM (`tutor-llm`) continua a existir como enriquecimento opcional
//! quando há `ANTHROPIC_API_KEY`; o conselheiro interno é o que torna a «linha
//! vermelha» útil mesmo sem chave nenhuma.

use crate::lang::Diagnostic;

/// Devolve uma sugestão de correcção para um diagnóstico, se reconhecermos o
/// padrão. `language` é `"rust"`, `"js"`, … (o despacho é tolerante a variantes).
pub fn advise(language: &str, diag: &Diagnostic) -> Option<String> {
    let msg = diag.message.to_lowercase();
    let lang = language.trim().to_lowercase();
    match lang.as_str() {
        "js" | "javascript" | "ts" | "typescript" => advise_js(&msg),
        _ => advise_rust(&msg),
    }
}

/// Regras para mensagens do `rustc` (via `cargo check`).
fn advise_rust(msg: &str) -> Option<String> {
    // A ordem importa: padrões mais específicos primeiro.
    let rules: &[(&[&str], &str)] = &[
        (
            &["expected `;`"],
            "Add a semicolon `;` at the end of this statement.",
        ),
        (
            &["expected `,`"],
            "Add a comma `,` to separate these items.",
        ),
        (
            &["unclosed delimiter"],
            "A bracket is left open — balance your `{ }`, `( )` or `[ ]`.",
        ),
        (
            &["mismatched closing delimiter"],
            "A closing bracket doesn't match its opener — check `{ } ( ) [ ]`.",
        ),
        (
            &["cannot find value"],
            "This name isn't in scope — check the spelling, or declare it with `let`.",
        ),
        (
            &["cannot find function"],
            "This function isn't in scope — check the name, or bring it in with `use`.",
        ),
        (
            &["cannot find type", "cannot find trait"],
            "This type/trait isn't in scope — check the name or add a `use` import.",
        ),
        (
            &["unresolved import"],
            "This `use` path doesn't resolve — check the module path and spelling.",
        ),
        (
            &["no method named"],
            "That method doesn't exist on this type — check the type, or import the trait that provides it.",
        ),
        (
            &["mismatched types"],
            "The types don't line up — compare what the expression produces with what's expected (e.g. `&str` vs `String`, `usize` vs `i32`).",
        ),
        (
            &["cannot borrow", "as mutable"],
            "You need a mutable binding — declare it `let mut …`, or take `&mut`.",
        ),
        (
            &["borrow of moved value", "use of moved value"],
            "This value was moved — `clone()` it, or borrow with `&` instead of moving.",
        ),
        (
            &["missing lifetime specifier"],
            "Rust needs a lifetime here — annotate it, e.g. `<'a>` on the function and the references.",
        ),
        (
            &["type annotations needed"],
            "Rust can't infer the type — add an annotation, e.g. `let x: Vec<_> = …`.",
        ),
        (
            &["this function takes", "but"],
            "The number of arguments doesn't match the signature — check the call.",
        ),
        (
            &["not all trait items implemented", "missing"],
            "A required trait item is missing — implement every method the trait declares.",
        ),
        (
            &["expected one of"],
            "Unexpected token — check the syntax just before this point (a missing `;`, `,`, `}` or keyword).",
        ),
    ];
    first_match(msg, rules)
}

/// Regras para erros do motor JS (QuickJS) / sintaxe JavaScript.
fn advise_js(msg: &str) -> Option<String> {
    let rules: &[(&[&str], &str)] = &[
        (
            &["unexpected token"],
            "Unexpected token — look for a missing `)`, `}` or `,` just before here.",
        ),
        (
            &["unexpected end of input"],
            "Something isn't closed — check for an unbalanced bracket or an unterminated string.",
        ),
        (
            &["is not defined"],
            "This name isn't defined — check the spelling, or declare it with `let`/`const`.",
        ),
        (
            &["is not a function"],
            "You're calling something that isn't a function — check the value's type or the method name.",
        ),
        (
            &["cannot read properties", "cannot read property"],
            "You're reading a property of `undefined`/`null` — guard the value before accessing it.",
        ),
        (
            &["missing ) after argument list"],
            "A call is missing its closing `)` — balance the parentheses.",
        ),
        (
            &["invalid or unexpected token"],
            "There's a stray or invalid character — check quotes and operators on this line.",
        ),
        (
            &["duplicate declaration", "has already been declared"],
            "This name is declared twice — rename one, or reuse the existing binding.",
        ),
    ];
    first_match(msg, rules)
}

/// Primeira regra cujos termos TODOS aparecem na mensagem.
fn first_match(msg: &str, rules: &[(&[&str], &str)]) -> Option<String> {
    for (needles, advice) in rules {
        if needles.iter().all(|n| msg.contains(n)) {
            return Some((*advice).to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lang::Severity;

    fn diag(message: &str) -> Diagnostic {
        Diagnostic {
            line: 1,
            col: 1,
            severity: Severity::Error,
            message: message.to_string(),
        }
    }

    #[test]
    fn rust_ponto_e_virgula() {
        let a = advise("rust", &diag("expected `;`, found `}`")).unwrap();
        assert!(a.to_lowercase().contains("semicolon"));
    }

    #[test]
    fn rust_valor_fora_de_escopo() {
        let a = advise("rust", &diag("cannot find value `freq` in this scope")).unwrap();
        assert!(a.to_lowercase().contains("scope"));
    }

    #[test]
    fn rust_tipos_incompativeis() {
        let a = advise("rust", &diag("mismatched types: expected `String`, found `&str`")).unwrap();
        assert!(!a.is_empty());
    }

    #[test]
    fn js_nao_definido() {
        let a = advise("js", &diag("ReferenceError: foo is not defined")).unwrap();
        assert!(a.to_lowercase().contains("defined"));
    }

    #[test]
    fn padrao_desconhecido_nao_inventa() {
        assert!(advise("rust", &diag("some entirely novel diagnostic text")).is_none());
    }
}
