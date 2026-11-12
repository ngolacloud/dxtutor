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
}
