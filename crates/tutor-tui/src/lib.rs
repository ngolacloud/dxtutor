//! `tutor-tui` — a casca do dxtutor: um editor TUI que conduz o aluno fase a fase.
//!
//! O cérebro vive em `tutor-eval`; aqui só editamos, submetemos e mostramos o
//! resultado. Ao passar a correcção, o gabarito revela-se automaticamente.

mod app;
mod ui;

use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};

use tutor_core::load_project;

use app::App;

/// Abre o editor-tutor para o projecto dado (ex.: `"rust-word-frequency"`).
pub fn run(project_id: &str) -> Result<()> {
    let project = load_project(project_id)
        .with_context(|| format!("projecto-tutor não encontrado: {project_id}"))?;
    let mut app = App::new(project);

    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, &mut app);
    ratatui::restore();
    result
}

/// Renderiza uma fase para texto, sem terminal real (para capturas e docs).
/// `gabarito` revela o painel do gabarito; `phase_idx` escolhe a fase.
pub fn snapshot(project_id: &str, phase_idx: usize, gabarito: bool) -> Result<String> {
    use ratatui::{backend::TestBackend, Terminal};

    let project = load_project(project_id)
        .with_context(|| format!("projecto-tutor não encontrado: {project_id}"))?;
    let mut app = App::new(project);
    for _ in 0..phase_idx {
        app.next_phase();
    }
    if gabarito {
        app.toggle_gabarito();
    }

    let mut terminal = Terminal::new(TestBackend::new(110, 34))?;
    terminal.draw(|f| ui::draw(f, &app))?;
    let buf = terminal.backend().buffer();
    let area = *buf.area();
    let mut s = String::new();
    for y in 0..area.height {
        for x in 0..area.width {
            if let Some(cell) = buf.cell((x, y)) {
                s.push_str(cell.symbol());
            }
        }
        s.push('\n');
    }
    Ok(s)
}

fn event_loop(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> Result<()> {
    loop {
        terminal.draw(|f| ui::draw(f, app))?;

        if app.quit {
            return Ok(());
        }

        // Recolhe os resultados em fundo (avaliação e dica), se prontos.
        app.poll_eval();
        app.poll_hint();

        // Enquanto trabalha em fundo, ciclamos depressa para animar o spinner;
        // parados, esperamos mais para poupar CPU.
        let timeout = if app.evaluating || app.hinting {
            Duration::from_millis(80)
        } else {
            Duration::from_millis(250)
        };

        if event::poll(timeout)? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Release {
                    handle_key(app, key);
                }
            }
        } else {
            app.tick();
        }
    }
}

fn handle_key(app: &mut App, key: crossterm::event::KeyEvent) {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char('q') if ctrl => app.quit = true,
        KeyCode::Char('c') if ctrl => app.quit = true,
        KeyCode::F(1) => app.request_hint(),
        KeyCode::F(5) => app.request_eval(),
        KeyCode::F(2) => app.toggle_gabarito(),
        KeyCode::F(4) => app.reset_starter(),
        KeyCode::F(7) => app.prev_phase(),
        KeyCode::F(8) => app.next_phase(),
        KeyCode::PageUp => app.instr_scroll = app.instr_scroll.saturating_sub(3),
        KeyCode::PageDown => app.instr_scroll = app.instr_scroll.saturating_add(3),
        _ => {
            // Tudo o resto é edição de texto.
            app.editor.input(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn render(app: &App) -> String {
        let mut terminal = Terminal::new(TestBackend::new(110, 34)).unwrap();
        terminal.draw(|f| ui::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer();
        let area = *buf.area();
        let mut s = String::new();
        for y in 0..area.height {
            for x in 0..area.width {
                if let Some(cell) = buf.cell((x, y)) {
                    s.push_str(cell.symbol());
                }
            }
            s.push('\n');
        }
        s
    }

    fn app() -> App {
        App::new(load_project("rust-word-frequency").unwrap())
    }

    /// Provider de dicas fake, em memória — devolve texto fixo, sem rede.
    struct FakeHints;
    impl tutor_llm::HintProvider for FakeHints {
        fn hint(&self, req: &tutor_llm::HintRequest) -> anyhow::Result<String> {
            Ok(format!("Pista fake nivel {}: relê as instruções.", req.level()))
        }
    }

    fn app_fake() -> App {
        use std::sync::Arc;
        App::with_hint_provider(
            load_project("rust-word-frequency").unwrap(),
            Arc::new(FakeHints),
        )
    }

    #[test]
    fn desenha_a_moldura_principal() {
        let screen = render(&app());
        assert!(screen.contains("dxtutor"), "cabeçalho em falta");
        assert!(screen.contains("fase 1/3"), "indicador de fase em falta");
        assert!(screen.contains("Código"), "painel do editor em falta");
        assert!(screen.contains("Instruções"), "painel de instruções em falta");
        assert!(screen.contains("tokenize"), "código inicial não carregou");
        assert!(screen.contains("F5 avaliar"), "barra de atalhos em falta");
        assert!(screen.contains("F1 dica"), "atalho da dica em falta");
    }

    #[test]
    fn dica_aparece_no_painel() {
        let mut a = app_fake();
        assert!(!render(&a).contains("Pista fake"), "não devia haver dica antes de pedir");

        a.request_hint();
        assert!(a.hinting, "devia estar a pensar logo após request_hint");
        assert_eq!(a.hint_level, 1, "primeiro pedido é nível 1");
        // Enquanto pensa, o painel mostra o spinner "a pensar".
        assert!(render(&a).contains("A pensar"), "spinner da dica em falta");

        let mut done = false;
        for _ in 0..200 {
            if a.poll_hint() {
                done = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(done, "a dica assíncrona não chegou a tempo");
        assert!(!a.hinting, "devia ter deixado de pensar");

        let screen = render(&a);
        assert!(screen.contains("Pista fake nivel 1"), "texto da dica em falta no painel");
        assert!(screen.contains("Dica (nível 1)"), "título do painel de dica em falta");
    }

    #[test]
    fn nivel_da_dica_sobe_ate_tres() {
        let mut a = app_fake();
        for esperado in [1u8, 2, 3, 3, 3] {
            a.request_hint();
            // Recolhe (o provider fake é instantâneo).
            for _ in 0..200 {
                if a.poll_hint() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            assert_eq!(a.hint_level, esperado, "o nível devia subir e fixar em 3");
        }
    }

    #[test]
    fn navegacao_entre_fases() {
        let mut a = app();
        assert_eq!(a.phase().entry, "tokenize");
        a.next_phase();
        assert_eq!(a.phase().entry, "count_frequencies");
        a.next_phase();
        assert_eq!(a.phase().entry, "top_k");
        a.next_phase(); // já na última
        assert_eq!(a.phase().entry, "top_k");
        a.prev_phase();
        assert_eq!(a.phase().entry, "count_frequencies");
    }

    #[test]
    fn gabarito_revela_no_painel() {
        let mut a = app();
        assert!(!render(&a).contains("GABARITO"));
        a.toggle_gabarito();
        let screen = render(&a);
        assert!(screen.contains("GABARITO"), "gabarito não apareceu");
        assert!(screen.contains("Referência"), "complexidade de referência em falta");
    }

    #[test]
    #[ignore = "corre cargo aninhado; prova o caminho de avaliação assíncrona"]
    fn avaliacao_assincrona_entrega_resultado() {
        use tui_textarea::TextArea;

        let mut a = app();
        // Injecta a solução do gabarito como se o aluno a tivesse escrito.
        let sol = a.phase().gabarito.solution.clone();
        a.editor = TextArea::from(sol.lines().map(str::to_string).collect::<Vec<_>>());

        a.request_eval();
        assert!(a.evaluating, "devia estar a avaliar logo após request_eval");
        // Enquanto avalia, o painel mostra o spinner (UI responsiva).
        assert!(render(&a).contains("A avaliar"), "spinner em falta durante a avaliação");

        let mut done = false;
        for _ in 0..600 {
            if a.poll_eval() {
                done = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(done, "a avaliação assíncrona não terminou a tempo");
        assert!(!a.evaluating, "devia ter deixado de avaliar");

        let last = a.last.as_ref().expect("resultado presente");
        assert!(last.correctness.passed, "o gabarito tinha de passar");
        assert!(a.show_gabarito, "devia revelar o gabarito ao passar");
        assert!(render(&a).contains("bate o óptimo"), "veredicto de complexidade em falta");
    }

    #[test]
    fn repor_volta_ao_codigo_inicial() {
        let mut a = app();
        a.editor.insert_str("// lixo do aluno");
        assert!(render(&a).contains("lixo do aluno"));
        a.reset_starter();
        assert!(!render(&a).contains("lixo do aluno"));
        assert!(render(&a).contains("tokenize"));
    }
}
