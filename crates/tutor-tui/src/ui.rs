//! Desenho da interface: editor | (instruções / resultado+gabarito) + barra.

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};

use tutor_eval::{Assessment, Class, Confidence};

use crate::app::{App, Status};

pub fn draw(f: &mut Frame, app: &App) {
    let root = Layout::vertical([
        Constraint::Length(1), // cabeçalho
        Constraint::Min(5),    // corpo
        Constraint::Length(1), // barra de estado
    ])
    .split(f.area());

    header(f, app, root[0]);

    let body = Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)])
        .split(root[1]);

    editor(f, app, body[0]);

    let right = Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(body[1]);
    instructions(f, app, right[0]);
    result(f, app, right[1]);

    status_bar(f, app, root[2]);
}

fn header(f: &mut Frame, app: &App, area: Rect) {
    let ph = app.phase();
    let text = format!(
        " dxtutor · {} — fase {}/{} · {:?} ",
        app.project.title,
        app.phase_idx + 1,
        app.project.phases.len(),
        ph.level,
    );
    let p = Paragraph::new(text).style(
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    );
    f.render_widget(p, area);
}

fn editor(f: &mut Frame, app: &App, area: Rect) {
    // Clonamos o widget só para lhe pôr a moldura sem mutar o estado.
    let mut ta = app.editor.clone();
    let title = format!(" Código — implementa `{}()` ", app.phase().entry);
    ta.set_block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Blue))
            .title(title),
    );
    f.render_widget(&ta, area);
}

fn instructions(f: &mut Frame, app: &App, area: Rect) {
    let ph = app.phase();
    let p = Paragraph::new(markdown(&ph.instructions))
        .wrap(Wrap { trim: false })
        .scroll((app.instr_scroll, 0))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Instruções  (PgUp/PgDn p/ rolar) "),
        );
    f.render_widget(p, area);
}

fn result(f: &mut Frame, app: &App, area: Rect) {
    let dica_title = format!(" Dica (nível {})  (F1 outra) ", app.hint_level.max(1));
    let title: &str = if app.show_gabarito {
        " Gabarito + veredicto  (F2 esconde) "
    } else if app.hinting || app.hint.is_some() {
        &dica_title
    } else {
        " Resultado  (F5 avalia) "
    };
    let lines = result_lines(app);
    let p = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((app.result_scroll, 0))
        .block(Block::default().borders(Borders::ALL).title(title));
    f.render_widget(Clear, area);
    f.render_widget(p, area);
}

fn result_lines(app: &App) -> Vec<Line<'static>> {
    let mut out: Vec<Line> = Vec::new();

    if app.hinting {
        out.push(Line::styled(
            format!(
                "{} A pensar numa dica (nível {})…",
                app.spinner_frame(),
                app.hint_level.max(1),
            ),
            Style::default().fg(Color::Yellow),
        ));
        return out;
    }

    if app.evaluating {
        out.push(Line::styled(
            format!(
                "{} A avaliar — a compilar e a cronometrar a tua solução…",
                app.spinner_frame()
            ),
            Style::default().fg(Color::Yellow),
        ));
        return out;
    }

    // Uma dica, quando existe, aparece em destaque no topo do painel sem
    // apagar o veredicto. Nunca julga correcção nem revela a solução.
    if let Some(hint) = &app.hint {
        if !app.show_gabarito {
            out.push(Line::styled(
                format!("── DICA (nível {}) ──────────────────────", app.hint_level.max(1)),
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
            ));
            for l in hint.trim().lines() {
                out.push(Line::styled(l.to_string(), Style::default().fg(Color::Yellow)));
            }
            out.push(Line::raw(""));
            out.push(Line::styled(
                "(A dica orienta; quem decide a correcção são os testes — F5.)",
                Style::default().fg(Color::DarkGray),
            ));
            out.push(Line::raw(""));
        }
    }

    if let Some(a) = &app.last {
        verdict_lines(a, &mut out);
        out.push(Line::raw(""));
    } else if !app.show_gabarito && app.hint.is_none() {
        out.push(Line::styled(
            "Escreve a tua solução e carrega em F5 para avaliar.",
            Style::default().fg(Color::DarkGray),
        ));
        out.push(Line::raw(""));
        out.push(Line::raw(
            "A correcção é julgada pelos testes; a complexidade é medida",
        ));
        out.push(Line::raw(
            "empiricamente. F2 mostra/esconde o gabarito.",
        ));
    }

    if app.show_gabarito {
        let g = &app.phase().gabarito;
        out.push(Line::styled(
            "── GABARITO ─────────────────────────────",
            Style::default().fg(Color::Magenta).add_modifier(Modifier::BOLD),
        ));
        out.push(Line::from(vec![
            Span::raw("Referência:  tempo "),
            Span::styled(g.time.clone(), Style::default().fg(Color::Cyan)),
            Span::raw("   espaço "),
            Span::styled(g.space.clone(), Style::default().fg(Color::Cyan)),
        ]));
        out.push(Line::raw(""));
        for l in g.solution.trim().lines() {
            out.push(Line::styled(
                l.to_string(),
                Style::default().fg(Color::Green),
            ));
        }
        out.push(Line::raw(""));
        for l in markdown(&g.justification).lines() {
            out.push(Line::raw(l.to_string()));
        }
    }

    out
}

fn verdict_lines(a: &Assessment, out: &mut Vec<Line<'static>>) {
    let (mark, color) = if a.correctness.passed {
        ("✓ CORRECÇÃO: passou", Color::Green)
    } else {
        ("✗ CORRECÇÃO: falhou", Color::Red)
    };
    out.push(Line::styled(
        format!("{mark}  ({})", a.correctness.summary),
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    ));

    if !a.correctness.passed {
        out.push(Line::raw(""));
        for l in a.correctness.raw.lines().take(12) {
            out.push(Line::styled(
                l.to_string(),
                Style::default().fg(Color::Red),
            ));
        }
        return;
    }

    match &a.complexity {
        None => out.push(Line::raw("Complexidade: (fase sem sonda)")),
        Some(est) => {
            let conf = match est.confidence {
                Confidence::High => "alta",
                Confidence::Medium => "média",
                Confidence::Low => "baixa",
            };
            out.push(Line::from(vec![
                Span::raw("Complexidade medida: "),
                Span::styled(
                    est.big_o().to_string(),
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                ),
                Span::raw(format!(
                    "  (R²={:.3}, p={:.2}, confiança {conf})",
                    est.r_squared, est.loglog_exponent
                )),
            ]));
            if let Some(expected) = a.expected {
                let (txt, color) = verdict(est.best, expected);
                out.push(Line::from(vec![
                    Span::raw(format!("Esperado: {}  →  ", expected.big_o())),
                    Span::styled(txt, Style::default().fg(color)),
                ]));
            }
        }
    }
}

fn verdict(measured: Class, expected: Class) -> (String, Color) {
    use std::cmp::Ordering;
    match rank(measured).cmp(&rank(expected)) {
        Ordering::Equal => ("✓ bate o óptimo".into(), Color::Green),
        Ordering::Less => ("✓ melhor que o esperado".into(), Color::Green),
        Ordering::Greater => (
            "⚠ pior que o óptimo — vê o gabarito".into(),
            Color::Yellow,
        ),
    }
}

fn rank(c: Class) -> u8 {
    match c {
        Class::Constant => 0,
        Class::Logarithmic => 1,
        Class::Linear => 2,
        Class::Linearithmic => 3,
        Class::Quadratic => 4,
        Class::Cubic => 5,
        Class::Exponential => 6,
    }
}

fn status_bar(f: &mut Frame, app: &App, area: Rect) {
    let keys = " F1 dica · F5 avaliar · F2 gabarito · F7/F8 fase ◂▸ · F4 repor · Ctrl+Q sair ";
    let msg = match &app.status {
        Status::Message(m) => format!("  {m}"),
        Status::Evaluating => "  a avaliar…".to_string(),
        Status::Editing => String::new(),
    };
    let line = Line::from(vec![
        Span::styled(
            keys,
            Style::default().fg(Color::Black).bg(Color::Gray),
        ),
        Span::styled(msg, Style::default().fg(Color::Yellow)),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

/// Simplificação de Markdown suficiente para o painel (tira `#`, mantém o resto).
fn markdown(s: &str) -> String {
    s.trim()
        .lines()
        .map(|l| l.trim_end().trim_start_matches('#').trim_start())
        .collect::<Vec<_>>()
        .join("\n")
}
