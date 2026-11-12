# AGENTS.md — working on dxtutor

dxtutor is a guided programming tutor **and** a code IDE. A Cargo workspace of `tutor-*`
crates (the "brain") plus a Tauri desktop shell (`desktop/`) with a Monaco frontend.

## Architecture (where things live)

| Area | Path | What it owns |
|------|------|--------------|
| Domain + curated content | `crates/tutor-core` | Course/Unit/Step, Phase, Gabarito; TOML content in `content/` |
| Evaluator + tools | `crates/tutor-eval` | `assess` (tests = truth), complexity probe, sandbox (`runner.rs`), `review.rs` (offline analyzers + fix identity), `codemap.rs` |
| AI providers + policy | `crates/tutor-llm` | hint/plan/fix providers, `chat.rs` (Dev Assistant), **`policy.rs` (study-mode authority)** |
| TUI shell | `crates/tutor-tui` | ratatui editor |
| Desktop backend | `desktop/src-tauri/src/main.rs` | Tauri commands (thin: they call the crates) |
| Desktop frontend | `desktop/src/*.ts` | Monaco editor, `review.ts`, `assistant.ts`, `edit.ts`, `workspace.ts` |

Two audiences that **must not** share permissions: the **engineering agents** that modify
this repo, and the **in-IDE tutor** that helps a student. An implementation agent's write
access never becomes the tutor's — the tutor's limits are enforced by `tutor-llm::policy`,
not by convention.

## The honesty contracts (do not regress)

1. **Correctness is decided by tests**, never by a model. Complexity is an *empirical
   estimate*, labelled as such.
2. **The gabarito (reference solution) ships only after the tests pass.** `reveal_gabarito`
   in `main.rs` gates it; a failed attempt serializes `gabarito: null`.
3. **The student writes the final implementation.** In study mode the AI surfaces tutor
   (explain/hint/question) — they never hand over the solution or write the buffer. See
   `tutor-llm::policy`.
4. **A review result is tied to the revision it analyzed.** A fix/marker computed over one
   buffer is refused on another (`content_version` + `verify_fix`).

## Real commands (verified on this host)

```bash
# Fast contract lane + frontend build + full workspace tests (default):
scripts/verify.sh
scripts/verify.sh --contracts-only     # just the P0 regression tests
scripts/verify.sh --all                # + analyzer-backed e2e (needs clippy/go/ruff)

cargo test -p tutor-eval -p tutor-llm --lib   # workspace crate tests (fast)
( cd desktop/src-tauri && cargo test )        # Tauri backend tests (P0-1 boundary)
( cd desktop/src-tauri && cargo check )       # backend typecheck (webkit2gtk-4.1 + gtk3)
( cd desktop && npm run build )               # tsc --noEmit + vite build  (Node via nvm)
( cd desktop && npm run tauri dev )           # run the app live (needs a display)
```

A **green workspace test does not cover the Tauri backend or the frontend** — they are
separate build units. Run all three before calling a change done.

## Tests before done

Every change to product source must run its layer of `scripts/verify.sh` and land a test
that fails on the old behaviour. For a P0-class change, show the regression: revert the
fix, see the named test fail, restore. **Commit before any destructive `git checkout`
proof** — an uncommitted change is discarded by it.

## Authorship

Commits are authored by **angolardevops**. **Never** add `Co-Authored-By` or Claude
trailers. Conventional Commit subjects (`fix(...)`, `feat(...)`, `test(...)`, `docs(...)`).

## Skills (canonical source: `.claude/skills/`)

| Skill | Use when you touch | Directory |
|-------|--------------------|-----------|
| Pedagogy & authoring | assessments, curriculum, study chat, placeholders, hints | `.claude/skills/pedagogy-authoring/` |
| Editor & code intelligence | buffers, diagnostics, LSP, CodeMap, fixes, undo | `.claude/skills/editor-code-intelligence/` |
| Assistance & providers | AI context, capabilities, transport, streaming, tools | `.claude/skills/assistance-providers/` |
| Validation & release | cross-cutting changes or shipping | `.claude/skills/validation-release/` |

These four are the single source of truth. Other executors should link here, not copy.

## Agent roles (sequential or parallel with independent boundaries)

- **Coordinator** — scopes the increment; names the owner of each write area.
- **Implementer** — reproduces, fixes, lands the test.
- **Reviewer** — confronts the diff with the product contract (the four honesty contracts).
- **Validator** — runs the scenario through the normal entry point and records the result.

A handoff carries: SHA, observed behaviour, files touched, a reproducible command, and the
open question. Engineering agents must work with the local tests and **no production
credentials**.
