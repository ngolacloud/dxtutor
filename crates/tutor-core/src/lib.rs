//! `tutor-core` — modelo de domínio e conteúdo curado do dxtutor.

pub mod content;
pub mod course;
pub mod glossary;
pub mod model;
pub mod study;

pub use content::{builtin_projects, find_phase, load_project};
pub use course::{builtin_courses, load_course, Course, Step, StepKind, Unit};
pub use glossary::{builtin_glossaries, load_glossary, Glossary, GlossaryEntry};
pub use model::{Gabarito, Level, Phase, Probe, Project};
pub use study::{load_study_guide, StudyGuide};
