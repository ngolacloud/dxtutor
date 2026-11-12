---
name: editor-code-intelligence
description: Use when changing dxtutor editor buffers, diagnostics, review findings, the CodeMap/LSP navigation, machine-applicable fixes or undo. Guards revision identity — a result computed over one buffer must never paint or apply onto a buffer that has since changed.
---

# Editor & code intelligence

## When this applies
Changes to `crates/tutor-eval/review.rs` or `codemap.rs`, `desktop/src/review.ts`,
`desktop/src/workspace.ts` (markers/apply/ghost), `desktop/src/edit.ts`, or the
`review_code`/`verify_review_fix`/`symbol_relations` commands.

## Inputs
The real project file(s), the review scope (file/changes/project), and the buffer's
content version at analysis time (`ReviewReport.fileVersions`, keyed by the finding path).

## Invariants you must preserve
1. **Revision identity.** Before painting a marker or applying a fix, verify the live
   buffer still hashes to the analyzed `content_version`. On drift: refuse, preserve the
   developer's edits, tell them to re-run. (`verify_fix` is the backend authority.)
2. `content_version` in `review.rs` and its mirror in `workspace.ts` must stay byte-identical.
3. A fix applies all its edits atomically or none (never a partial, file-breaking apply).
4. Fallback/inferred results (syntactic CodeMap, snippet-less fixes) are labelled as such.

## Steps
1. Reproduce on REAL files (not guided snippets).
2. Thread the analyzed version through: review → store → verify before paint → verify
   before apply.
3. Test the identity decision as a pure function (`verify_fix`), plus the snippet and
   hash paths separately.

## Commands (verified)
```bash
cargo test -p tutor-eval --lib review::      # identity + analyzers
( cd desktop && npm run build )              # frontend typecheck + build
scripts/verify.sh --all                      # + clippy/go/ruff-backed e2e
```

## Expected evidence
Review, insert a line, receive the old result → apply is refused and the edit is preserved;
repeat across a tab switch and a prior run's result. A snippet-less (Ruff-style) fix is still
refused on drift (hash gate). Show the regression fails when the gate is removed.

## On failure
If a stale fix lands, check both gates in `verify_fix` (hash, then expected snippet) and that
the frontend passes the analyzed version to `applyReviewEdits`. If markers paint on moved
code, the freshness check in `review.ts` `navigate()` is missing or the version key mismatches
the finding path.

## Exercised
Landed and proven in P0-3 (commits `b24b538`, `048d61c`): reverting the hash gate fails
`review::tests::stale_buffer_without_snippet_relies_on_hash`.
