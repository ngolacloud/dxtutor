//! `tutor-core` — modelo de domínio e conteúdo curado do dxtutor.

pub mod content;
pub mod course;
pub mod curriculum;
pub mod glossary;
pub mod model;
pub mod study;

pub use content::{builtin_projects, find_phase, load_project};
pub use course::{builtin_courses, load_course, Course, Step, StepKind, Unit};
// `curriculum::Unit` keeps its own name (course::Unit already occupies `Unit`).
pub use curriculum::{Competency, Curriculum, EvidenceKind, Program};
pub use glossary::{builtin_glossaries, load_glossary, Glossary, GlossaryEntry};
pub use model::{Gabarito, Level, Phase, Probe, Project};
pub use study::{load_study_guide, StudyGuide};
