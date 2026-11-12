---
name: validation-release
description: Use for cross-cutting dxtutor changes or preparing a release. Runs the applicable harness lanes, publishes reproducible results and limitations, and keeps the README's claimed state matching what the delivered build can demonstrate.
---

# Validation & release

## When this applies
A change that spans crates + backend + frontend, or any prep for shipping / tagging.

## Inputs
The diff, the host's available tools (`cargo clippy`, `/usr/local/go/bin/go`, `ruff`,
`rust-analyzer`, `ollama`), and whether a display is available for a live app run.

## Invariants you must preserve
1. The same command re-runs without mutating the example project or depending on a prior
   run's output.
2. A mandatory scenario that fails must fail the process. A scenario needing an absent tool
   or credential is reported **not executed (reason)** — never a silent pass.
3. Distinguish **simulated** (offline/fake), **validated with a real tool**, and
   **demonstrated through the IDE**. Say which one each result is.
4. The README's "what it can demonstrate" matches the delivered build.

## Steps
1. `scripts/verify.sh` (fast: contracts + editor + workspace). Then `--all` when analyzers
   are present.
2. For a release, also: `( cd desktop/src-tauri && cargo check )`, a live
   `npm run tauri dev` smoke (record OS + tool versions + display requirement), and a
   per-language / per-provider capability note.
3. Record results, limitations and the capability matrix in the PR/handoff.

## Commands (verified)
```bash
scripts/verify.sh            # exit!=0 on any mandatory failure
scripts/verify.sh --all
cargo test --workspace
( cd desktop/src-tauri && cargo check )
( cd desktop && npm run build )
```

## Expected evidence
A green `scripts/verify.sh` with an explicit "not executed" list; for each P0, proof that
the regression catches the old behaviour (revert → fail → restore, committed first). A
capability matrix: per language (curriculum / review / navigation / tests / debug) and per
provider (what streams, what is gated).

## On failure
Read the per-lane log under `/tmp/dxtutor-*.log`. A missing analyzer is a SKIP to record,
not a fix. A real failure blocks the release until the named test passes.

## Exercised
`scripts/verify.sh` was built and run green this session (contracts + editor + workspace).
