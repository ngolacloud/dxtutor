//! Study-mode policy — the backend authority over what the AI surfaces may do while a
//! guided exercise is active.
//!
//! The honesty contract of dxtutor is that the **student writes the final
//! implementation**. A system prompt alone cannot guarantee that (a model can be talked
//! around it), so the guarantee here is *structural*: the backend decides the policy
//! from the active mode and step, and every AI entry point — chat, hints, inline
//! suggestions, plan/preview, auto-fix — consults it before producing anything. During
//! an autonomous-application exercise no path may hand over the final function body, an
//! equivalent patch, or write into the student's buffer.
//!
//! This governs the *tutor that sits beside the student inside the IDE*. It is a
//! separate concern from the engineering agents that modify the repository: an
//! implementation agent's write permissions never become, by inheritance, the tutor's.
//! And it is explicitly NOT a promise to hide local files from whoever administers the
//! machine — it shapes IDE-surface behaviour during the exercise, nothing more.

use serde::Serialize;

/// Which experience the user is in. Chosen explicitly by the frontend (the Study→Project
/// transition is a deliberate switch), then enforced here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A guided exercise is active — the tutor contract applies.
    Study,
    /// A real project is open — the assistant is a full pair-programmer.
    Project,
}

impl Mode {
    /// Parse the mode string the frontend sends. Anything unknown is treated as the
    /// stricter `Study` mode — fail closed, never fail open on the honesty contract.
    pub fn parse(s: &str) -> Mode {
        match s.trim().to_ascii_lowercase().as_str() {
            "project" | "workspace" => Mode::Project,
            _ => Mode::Study,
        }
    }
}

/// What the AI surfaces are allowed to do right now.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StudyPolicy {
    /// May a surface emit the complete reference solution / final function body?
    pub allow_full_solution: bool,
    /// May a surface write directly into the student's exercise buffer (apply a patch,
    /// insert generated code)?
    pub allow_buffer_write: bool,
    /// Is the chat constrained to the tutor contract (explain, question, hint — never
    /// solve) rather than being a free code generator?
    pub chat_is_tutor: bool,
}

impl StudyPolicy {
    /// The permissive policy: a real project, full pair-programming.
    pub const OPEN: StudyPolicy = StudyPolicy {
        allow_full_solution: true,
        allow_buffer_write: true,
        chat_is_tutor: false,
    };

    /// The strict policy: a guided exercise the student must solve themselves.
    pub const STRICT: StudyPolicy = StudyPolicy {
        allow_full_solution: false,
        allow_buffer_write: false,
        chat_is_tutor: true,
    };
}

/// A capability an AI surface may want to exercise. `enforce` maps the active policy
/// onto a yes/no so every command gates the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    /// Produce the final solution / full function body.
    EmitFullSolution,
    /// Write generated code into the student's buffer.
    WriteStudentBuffer,
    /// Free-form code generation in chat (as opposed to tutoring).
    FreeformCodegen,
}

/// Derive the policy from the active mode and whether the active step is an
/// autonomous-application exercise (a `challenge`: the student authors the
/// implementation). Syntax-transcription drills still forbid buffer writes during the
/// exercise, but a challenge is where the full-solution ban matters most.
///
/// `autonomous` should be computed from the real step (see `is_autonomous_step`), not
/// trusted from the client beyond the explicit mode switch.
pub fn policy_for(mode: Mode, autonomous: bool) -> StudyPolicy {
    match mode {
        Mode::Project => StudyPolicy::OPEN,
        // In study mode the tutor contract always holds; `autonomous` is kept for future
        // differentiation but today every study step is governed strictly.
        Mode::Study => {
            let _ = autonomous;
            StudyPolicy::STRICT
        }
    }
}

/// Whether `policy` permits `cap`. The single chokepoint every surface calls.
pub fn allows(policy: &StudyPolicy, cap: Capability) -> bool {
    match cap {
        Capability::EmitFullSolution => policy.allow_full_solution,
        Capability::WriteStudentBuffer => policy.allow_buffer_write,
        Capability::FreeformCodegen => !policy.chat_is_tutor,
    }
}

/// A human-readable refusal for a blocked capability, surfaced to the UI in place of the
/// forbidden content.
pub fn refusal(cap: Capability) -> String {
    match cap {
        Capability::EmitFullSolution => "The tutor won't write the solution for an active \
             exercise — that's yours to type. Ask for a hint, or switch to Project mode to \
             pair on real code."
            .to_string(),
        Capability::WriteStudentBuffer => "The tutor won't write into your exercise buffer. \
             You keep authorship of the implementation."
            .to_string(),
        Capability::FreeformCodegen => "While an exercise is open the assistant tutors — it \
             explains and asks guiding questions instead of generating the answer."
            .to_string(),
    }
}

/// The authoritative system directive prepended to every chat turn in study mode. It is
/// the *soft* layer (a capable model can still be pushed); the *hard* layer is that
/// `assistant_chat_stream` refuses `FreeformCodegen`/`EmitFullSolution` and no command
/// writes the buffer. Both run together.
pub fn tutor_directive() -> &'static str {
    "You are the dxtutor study tutor. A student is in the middle of a guided \
     programming exercise and MUST write the final implementation themselves. You may \
     explain concepts, point at documentation, give a counter-example, and ask guiding \
     questions. You must NOT provide the full solution, the final function body, a \
     line-for-line equivalent, or a patch the student could paste. If asked directly \
     for the answer, decline and offer the next smallest hint instead."
}

// ── Co-Dev approval matrix ──────────────────────────────────────────────────────────
//
// A second, independent axis from the study/project policy above. Once we are
// pair-programming in a real project, the *Co-Dev mode* chosen on the modebar
// (Manual/Assistido/Auto) decides whether each action needs the human's explicit
// approval or may proceed automatically. This is the backend authority the frontend
// consults, so the modebar governs edits/commands DE FACTO instead of being decorative.
//
// The safety floor the matrix must never break, regardless of mode: destructive
// filesystem/VCS actions and push ALWAYS ask. Auto chains steps, it does not remove the
// floor.

/// The Co-Dev approval mode, chosen on the modebar. Anything unknown falls back to the
/// strictest mode (`Manual`) — fail closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoDevMode {
    /// Every edit and command is approved by the human before it runs.
    Manual,
    /// Edits apply automatically (shown as a diff); destructive actions still ask.
    Assist,
    /// Co-Dev chains steps automatically; push and destructive actions always ask.
    Auto,
}

impl CoDevMode {
    pub fn parse(s: &str) -> CoDevMode {
        match s.trim().to_ascii_lowercase().as_str() {
            "assist" | "assisted" | "assistido" => CoDevMode::Assist,
            "auto" => CoDevMode::Auto,
            _ => CoDevMode::Manual,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            CoDevMode::Manual => "manual",
            CoDevMode::Assist => "assist",
            CoDevMode::Auto => "auto",
        }
    }
}

/// A class of action a Co-Dev surface may want to take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Apply an anchored edit to a file the user already has open.
    Edit,
    /// Run a non-destructive command (build, test, format…).
    RunCommand,
    /// A destructive filesystem/VCS action (discard, reset, delete, overwrite).
    Destructive,
    /// Publish to a remote (push) or any other outward, hard-to-undo action.
    Push,
}

/// Whether an action may proceed automatically or must be approved by the human first.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Approval {
    Ask,
    Auto,
}

/// The single chokepoint: whether `action` may proceed automatically under `mode`.
/// Destructive and Push ALWAYS ask — the safety floor is independent of the mode.
pub fn approval_for(mode: CoDevMode, action: Action) -> Approval {
    match action {
        Action::Destructive | Action::Push => Approval::Ask,
        Action::Edit | Action::RunCommand => match mode {
            CoDevMode::Manual => Approval::Ask,
            CoDevMode::Assist | CoDevMode::Auto => Approval::Auto,
        },
    }
}

/// Whether the mode chains steps without pausing (only `Auto`). `Assist` applies one step
/// automatically but still stops between steps.
pub fn chains(mode: CoDevMode) -> bool {
    matches!(mode, CoDevMode::Auto)
}

/// The approval policy snapshot the frontend consults so the modebar governs behaviour.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoDevPolicy {
    pub mode: &'static str,
    /// Do anchored edits need explicit approval (the inline diff Accept/Reject)?
    pub edits_need_approval: bool,
    /// Do non-destructive commands need explicit approval?
    pub commands_need_approval: bool,
    /// Does Co-Dev chain steps automatically?
    pub chains: bool,
    /// Always true — surfaced so the UI can state the guarantee: destructive actions and
    /// push ask in every mode.
    pub destructive_always_asks: bool,
}

/// Derive the Co-Dev policy from the modebar mode.
pub fn codev_policy(mode: CoDevMode) -> CoDevPolicy {
    CoDevPolicy {
        mode: mode.as_str(),
        edits_need_approval: approval_for(mode, Action::Edit) == Approval::Ask,
        commands_need_approval: approval_for(mode, Action::RunCommand) == Approval::Ask,
        chains: chains(mode),
        destructive_always_asks: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_mode_is_open() {
        let p = policy_for(Mode::Project, true);
        assert!(allows(&p, Capability::EmitFullSolution));
        assert!(allows(&p, Capability::WriteStudentBuffer));
        assert!(allows(&p, Capability::FreeformCodegen));
    }

    /// P0-2 core: in study mode no capability that would hand over the answer or write
    /// the student's buffer is allowed — regardless of which surface asks.
    #[test]
    fn study_mode_forbids_solution_and_buffer_writes() {
        for autonomous in [true, false] {
            let p = policy_for(Mode::Study, autonomous);
            assert!(!allows(&p, Capability::EmitFullSolution), "solution must be blocked");
            assert!(!allows(&p, Capability::WriteStudentBuffer), "buffer write must be blocked");
            assert!(!allows(&p, Capability::FreeformCodegen), "chat must be tutor-only");
        }
    }

    #[test]
    fn unknown_mode_fails_closed_to_study() {
        assert_eq!(Mode::parse("weird"), Mode::Study);
        assert_eq!(Mode::parse(""), Mode::Study);
        assert_eq!(Mode::parse("Project"), Mode::Project);
        assert_eq!(Mode::parse("workspace"), Mode::Project);
    }

    #[test]
    fn refusals_are_nonempty() {
        for cap in [
            Capability::EmitFullSolution,
            Capability::WriteStudentBuffer,
            Capability::FreeformCodegen,
        ] {
            assert!(!refusal(cap).is_empty());
        }
    }

    // ── Co-Dev approval matrix ──────────────────────────────────────────────

    #[test]
    fn codev_manual_asks_for_every_edit_and_command() {
        assert_eq!(approval_for(CoDevMode::Manual, Action::Edit), Approval::Ask);
        assert_eq!(approval_for(CoDevMode::Manual, Action::RunCommand), Approval::Ask);
        let p = codev_policy(CoDevMode::Manual);
        assert!(p.edits_need_approval);
        assert!(p.commands_need_approval);
        assert!(!p.chains);
    }

    #[test]
    fn codev_assist_and_auto_auto_apply_edits_and_commands() {
        for m in [CoDevMode::Assist, CoDevMode::Auto] {
            assert_eq!(approval_for(m, Action::Edit), Approval::Auto, "edits auto in {m:?}");
            assert_eq!(approval_for(m, Action::RunCommand), Approval::Auto, "commands auto in {m:?}");
            let p = codev_policy(m);
            assert!(!p.edits_need_approval);
            assert!(!p.commands_need_approval);
        }
        // Assist applies one step then stops; only Auto chains.
        assert!(!chains(CoDevMode::Assist));
        assert!(chains(CoDevMode::Auto));
    }

    /// The safety floor that must never break regardless of mode: destructive actions and
    /// push always require approval. This is the test that fails if the matrix stops
    /// governing (e.g. someone lets Auto bypass the floor).
    #[test]
    fn codev_destructive_and_push_always_ask_in_every_mode() {
        for m in [CoDevMode::Manual, CoDevMode::Assist, CoDevMode::Auto] {
            assert_eq!(approval_for(m, Action::Destructive), Approval::Ask, "destructive must ask in {m:?}");
            assert_eq!(approval_for(m, Action::Push), Approval::Ask, "push must ask in {m:?}");
            assert!(codev_policy(m).destructive_always_asks);
        }
    }

    #[test]
    fn codev_mode_parse_fails_closed_to_manual() {
        assert_eq!(CoDevMode::parse("assist"), CoDevMode::Assist);
        assert_eq!(CoDevMode::parse("Assistido"), CoDevMode::Assist);
        assert_eq!(CoDevMode::parse("auto"), CoDevMode::Auto);
        assert_eq!(CoDevMode::parse("weird"), CoDevMode::Manual);
        assert_eq!(CoDevMode::parse(""), CoDevMode::Manual);
    }
}
