//! Estado da aplicação TUI e a lógica de sessão de aprendizagem.

use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;

use tutor_core::{Phase, Project};
use tutor_eval::{assess, Assessment};
use tutor_llm::{default_provider, HintProvider, HintRequest};

use tui_textarea::TextArea;

const SPINNER: [char; 4] = ['|', '/', '-', '\\'];

/// O que o editor está a fazer agora.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// À espera do aluno.
    Editing,
    /// A correr o avaliador (bloqueia; mostramos o aviso antes).
    Evaluating,
    /// Mensagem curta de estado (erro de avaliação, etc.).
    Message(String),
}

/// Estado completo da sessão.
pub struct App {
    pub project: Project,
    pub phase_idx: usize,
    pub editor: TextArea<'static>,
    pub instr_scroll: u16,
    pub result_scroll: u16,
    pub status: Status,
    pub last: Option<Assessment>,
    pub show_gabarito: bool,
    pub quit: bool,
    /// Avaliação a decorrer em segundo plano.
    pub evaluating: bool,
    /// Última dica recebida (texto pedagógico), se houver.
    pub hint: Option<String>,
    /// Nível da próxima/última dica (1..=3); 0 enquanto não se pediu nenhuma.
    pub hint_level: u8,
    /// Dica a decorrer em segundo plano.
    pub hinting: bool,
    spinner: usize,
    rx: Option<Receiver<anyhow::Result<Assessment>>>,
    hint_rx: Option<Receiver<anyhow::Result<String>>>,
    hints: Arc<dyn HintProvider>,
}

impl App {
    pub fn new(project: Project) -> Self {
        App::with_hint_provider(project, Arc::from(default_provider()))
    }

    /// Como [`App::new`], mas com um provider de dicas injectado — útil para
    /// testes (provider fake, sem rede).
    pub fn with_hint_provider(project: Project, hints: Arc<dyn HintProvider>) -> Self {
        let mut app = App {
            project,
            phase_idx: 0,
            editor: TextArea::default(),
            instr_scroll: 0,
            result_scroll: 0,
            status: Status::Editing,
            last: None,
            show_gabarito: false,
            quit: false,
            evaluating: false,
            hint: None,
            hint_level: 0,
            hinting: false,
            spinner: 0,
            rx: None,
            hint_rx: None,
            hints,
        };
        app.load_phase();
        app
    }

    pub fn spinner_frame(&self) -> char {
        SPINNER[self.spinner % SPINNER.len()]
    }

    /// Avança a animação (chamar em cada tick enquanto se avalia ou pensa).
    pub fn tick(&mut self) {
        if self.evaluating || self.hinting {
            self.spinner = self.spinner.wrapping_add(1);
        }
    }

    pub fn phase(&self) -> &Phase {
        &self.project.phases[self.phase_idx]
    }

    /// Carrega o código inicial da fase actual no editor e limpa o resultado.
    pub fn load_phase(&mut self) {
        let starter = self.project.phases[self.phase_idx]
            .starter
            .trim_matches('\n');
        let mut editor = TextArea::from(starter.lines().map(|l| l.to_string()).collect::<Vec<_>>());
        editor.set_line_number_style(
            ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray),
        );
        self.editor = editor;
        self.last = None;
        self.show_gabarito = false;
        self.hint = None;
        self.hint_level = 0;
        self.instr_scroll = 0;
        self.result_scroll = 0;
        self.status = Status::Editing;
    }

    pub fn next_phase(&mut self) {
        if self.phase_idx + 1 < self.project.phases.len() {
            self.phase_idx += 1;
            self.load_phase();
        } else {
            self.status = Status::Message("Já estás na última fase.".into());
        }
    }

    pub fn prev_phase(&mut self) {
        if self.phase_idx > 0 {
            self.phase_idx -= 1;
            self.load_phase();
        } else {
            self.status = Status::Message("Já estás na primeira fase.".into());
        }
    }

    pub fn reset_starter(&mut self) {
        self.load_phase();
        self.status = Status::Message("Código reposto ao inicial.".into());
    }

    pub fn toggle_gabarito(&mut self) {
        self.show_gabarito = !self.show_gabarito;
        self.result_scroll = 0;
    }

    /// Lança o avaliador numa thread de fundo. A UI continua responsiva; o
    /// resultado chega por canal e é recolhido em [`App::poll_eval`].
    pub fn request_eval(&mut self) {
        if self.evaluating {
            return;
        }
        let (tx, rx) = mpsc::channel();
        let phase = self.phase().clone();
        let code = self.editor.lines().join("\n");
        std::thread::spawn(move || {
            let _ = tx.send(assess(&phase, &code));
        });
        self.rx = Some(rx);
        self.evaluating = true;
        self.spinner = 0;
        self.status = Status::Evaluating;
    }

    /// Verifica, sem bloquear, se a avaliação em fundo terminou. Devolve `true`
    /// se o estado mudou (para forçar um redesenho).
    pub fn poll_eval(&mut self) -> bool {
        let Some(rx) = &self.rx else { return false };
        match rx.try_recv() {
            Ok(result) => {
                self.rx = None;
                self.evaluating = false;
                self.result_scroll = 0;
                match result {
                    Ok(a) => {
                        if a.correctness.passed {
                            self.show_gabarito = true; // revela ao passar
                        }
                        self.last = Some(a);
                        self.status = Status::Editing;
                    }
                    Err(e) => self.status = Status::Message(format!("Falha ao avaliar: {e}")),
                }
                true
            }
            Err(TryRecvError::Empty) => false,
            Err(TryRecvError::Disconnected) => {
                self.rx = None;
                self.evaluating = false;
                self.status = Status::Message("o avaliador terminou inesperadamente".into());
                true
            }
        }
    }

    /// Pede uma dica ao provider numa thread de fundo. Sobe o nível a cada
    /// pedido, até 3. A UI nunca bloqueia à espera da rede; o texto chega por
    /// canal e é recolhido em [`App::poll_hint`].
    pub fn request_hint(&mut self) {
        if self.hinting {
            return;
        }
        self.hint_level = (self.hint_level + 1).min(3);

        // A saída dos testes só interessa como contexto quando a última
        // avaliação falhou.
        let test_output = self.last.as_ref().and_then(|a| {
            if a.correctness.passed {
                None
            } else {
                Some(a.correctness.raw.clone())
            }
        });

        let req = HintRequest {
            instructions: self.phase().instructions.clone(),
            entry: self.phase().entry.clone(),
            student_code: self.editor.lines().join("\n"),
            test_output,
            level: self.hint_level,
        };

        let (tx, rx) = mpsc::channel();
        let hints = Arc::clone(&self.hints);
        std::thread::spawn(move || {
            let _ = tx.send(hints.hint(&req));
        });
        self.hint_rx = Some(rx);
        self.hinting = true;
        self.spinner = 0;
        self.result_scroll = 0;
        self.status = Status::Message(format!("a pensar numa dica (nível {})…", self.hint_level));
    }

    /// Verifica, sem bloquear, se a dica em fundo chegou. Devolve `true` se o
    /// estado mudou (para forçar um redesenho).
    pub fn poll_hint(&mut self) -> bool {
        let Some(rx) = &self.hint_rx else { return false };
        match rx.try_recv() {
            Ok(result) => {
                self.hint_rx = None;
                self.hinting = false;
                self.result_scroll = 0;
                match result {
                    Ok(text) => {
                        self.hint = Some(text);
                        self.status = Status::Editing;
                    }
                    Err(e) => self.status = Status::Message(format!("Falha ao pedir dica: {e}")),
                }
                true
            }
            Err(TryRecvError::Empty) => false,
            Err(TryRecvError::Disconnected) => {
                self.hint_rx = None;
                self.hinting = false;
                self.status = Status::Message("o pedido de dica terminou inesperadamente".into());
                true
            }
        }
    }
}
