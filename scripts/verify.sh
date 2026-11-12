#!/usr/bin/env bash
# dxtutor verification harness.
#
# A reproducible entry point that proves the honesty + editor contracts, for local use
# and CI. The same command can be re-run without mutating any example project and without
# depending on a previous run's output.
#
# Layers (see docs/code-intelligence-roadmap.md §Harness):
#   contracts   Rust unit tests at the real serialization/apply boundaries (the 3 P0s).
#   editor      Frontend typecheck + production build (concurrency/apply logic compiles).
#   integration Tool-backed e2e (clippy/go/ruff/analyzers). Skipped (reported) if a tool
#               is absent — never a silent pass.
#
# Usage:
#   scripts/verify.sh            # fast lane: contracts + editor   (default, deterministic)
#   scripts/verify.sh --all      # also run the integration lane
#   scripts/verify.sh --contracts-only
#
# Exit code: non-zero if any MANDATORY check fails. A check that needs an absent tool is
# reported as "not executed (missing <tool>)", not as a pass.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "cannot cd to repo root"; exit 2; }

MODE="fast"
case "${1:-}" in
  --all) MODE="all" ;;
  --contracts-only) MODE="contracts" ;;
  "" ) ;;
  * ) echo "unknown arg: $1"; exit 2 ;;
esac

fail=0
skips=()
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$*"; skips+=("$*"); }

# ── Contracts lane (the three P0 regressions) ────────────────────────────────────────
# These three test names ARE the P0 contracts. Each fails on the pre-fix behaviour and
# passes with the fix (see docs/code-intelligence-roadmap.md for the revert recipe).
say "contracts — P0 regression tests"
# P0-2 (policy::tests::study_mode_forbids_solution_and_buffer_writes, …) and
# P0-3 (review::tests::stale_revision_fix_is_refused, …snippet_mismatch_is_refused) live
# in the workspace crates. cargo takes a single name filter, so run the lib suites whole.
if cargo test -p tutor-eval -p tutor-llm --lib >/tmp/dxtutor-contracts.log 2>&1; then
  ok "P0-2 study policy + P0-3 revision identity (tutor-eval, tutor-llm lib suites)"
else
  bad "P0-2/P0-3 contracts — see /tmp/dxtutor-contracts.log"; tail -20 /tmp/dxtutor-contracts.log
fi

# P0-1 (tests::failed_attempt_hides_gabarito) lives at the Tauri serialization boundary.
if ( cd desktop/src-tauri && cargo test ) >/tmp/dxtutor-p01.log 2>&1; then
  ok "P0-1 failed attempt hides the gabarito (dxtutor-desktop)"
else
  bad "P0-1 gabarito contract — see /tmp/dxtutor-p01.log"; tail -20 /tmp/dxtutor-p01.log
fi

if [ "$MODE" = "contracts" ]; then
  say "RESULT"
  if [ "$fail" -eq 0 ]; then ok "contracts passed"; exit 0; else bad "contracts failed"; exit 1; fi
fi

# ── Editor lane (frontend typecheck + build) ─────────────────────────────────────────
say "editor — frontend typecheck + build"
# Source nvm (if present) so the user's Node is on PATH, in a subshell that isolates
# nvm's scripting from this harness. Reported as "not executed" when no Node is found.
build_cmd='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use --lts >/dev/null 2>&1; command -v npm >/dev/null 2>&1 || exit 97; cd "'"$ROOT"'/desktop" && npm run build'
bash -c "$build_cmd" >/tmp/dxtutor-editor.log 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "tsc --noEmit + vite build"
elif [ "$rc" -eq 97 ]; then
  skip "frontend build (no npm/node on PATH or via nvm)"
else
  bad "frontend build — see /tmp/dxtutor-editor.log"; tail -25 /tmp/dxtutor-editor.log
fi

# ── Full workspace sanity (all crate tests) ──────────────────────────────────────────
say "workspace — full crate test suite"
if cargo test --workspace >/tmp/dxtutor-workspace.log 2>&1; then
  ok "cargo test --workspace"
else
  bad "workspace tests — see /tmp/dxtutor-workspace.log"; tail -25 /tmp/dxtutor-workspace.log
fi

# ── Integration lane (tool-backed) ───────────────────────────────────────────────────
if [ "$MODE" = "all" ]; then
  say "integration — analyzer-backed e2e (needs clippy / go / ruff)"
  cargo clippy --version >/dev/null 2>&1 && HAVE_CLIPPY=1 || HAVE_CLIPPY=0
  if [ "$HAVE_CLIPPY" = 1 ]; then
    if cargo test -p tutor-eval --lib review::tests::rust_review_finds_a_clippy_lint >/tmp/dxtutor-int.log 2>&1; then
      ok "Rust review finds a clippy lint"
    else
      bad "Rust review e2e — see /tmp/dxtutor-int.log"
    fi
  else
    skip "Rust review e2e (missing clippy)"
  fi
  command -v ruff >/dev/null 2>&1 \
    && { cargo test -p tutor-eval --lib review::tests::python_review_finds_undefined_name >/dev/null 2>&1 && ok "Python review finds F821" || bad "Python review e2e"; } \
    || skip "Python review e2e (missing ruff)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────────────
say "RESULT"
for s in "${skips[@]:-}"; do [ -n "$s" ] && printf '  not executed: %s\n' "$s"; done
if [ "$fail" -eq 0 ]; then ok "all mandatory checks passed"; exit 0; else bad "one or more mandatory checks failed"; exit 1; fi
