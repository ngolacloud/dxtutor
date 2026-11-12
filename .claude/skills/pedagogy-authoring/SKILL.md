---
name: pedagogy-authoring
description: Use when changing dxtutor assessments, curriculum/content TOML, the study-mode chat, drill placeholders, hints or AI suggestions shown during an exercise. Guards the honesty contract — tests decide correctness, the gabarito ships only on pass, and the student keeps authorship of the final implementation.
---

# Pedagogy & authoring

## When this applies
Any change under `crates/tutor-core/content/`, `crates/tutor-eval` assessment path,
`crates/tutor-llm` hint/plan/fix providers or `policy.rs`, the study UI in
`desktop/src/main.ts`, or the `submit`/`submit_step`/`request_hint`/`assistant_chat_stream`
commands.

## Inputs
The step/phase being edited (id, kind), the language, and whether an exercise is
autonomous-application (a `challenge`) vs transcription (a `drill`).

## Honesty invariants you must preserve
1. Correctness comes from hidden tests (`tutor_eval::assess`), never a model.
2. `reveal_gabarito(passed, …)` in `main.rs` — the gabarito is `None` unless the tests
   passed. A failed attempt must serialize `gabarito: null`.
3. Complexity is an empirical estimate, labelled as such — never a formal claim.
4. In study mode the AI tutors; it never emits the final body, an equivalent patch, or
   writes the student's buffer (`tutor-llm::policy`).

## Steps
1. Identify the affected surfaces (assessment serialization, chat, hints, placeholders).
2. Make the change; keep per-line `line_comments` aligned 1:1 with `target`.
3. For a new/edited challenge, confirm the reference solution passes and a wrong one fails.
4. Add/extend a test at the real boundary (serialization or policy), not just the UI.

## Commands (verified)
```bash
( cd desktop/src-tauri && cargo test )   # P0-1 gabarito boundary
cargo test -p tutor-llm --lib policy::   # study-mode policy
cargo test -p tutor-eval --lib           # evaluator/content
scripts/verify.sh --contracts-only
```

## Expected evidence
A failing-attempt payload with `gabarito: null` and no solution text anywhere; a passing
attempt that unlocks it; study-mode policy that forbids full-solution/buffer-write. Name
the test; show it fails on the old behaviour (revert, run, restore — commit first).

## On failure
If a test shows the solution leaking, the gate is the single `reveal_gabarito` call and the
`policy_for(Study, …)` result — fix there, not in the UI. If the model still volunteers the
answer in study mode, the structural guarantee (no buffer-write path, tutor routing) is what
you assert in tests; the system directive is best-effort.

## Exercised
This skill's contracts were landed and proven in the P0-1/P0-2 work (commit `b24b538`).
