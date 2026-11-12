---
name: assistance-providers
description: Use when changing the dxtutor Dev Assistant's context, provider capabilities, transport, streaming or AI tools. Covers pause/cancel/late-fragment/resume behaviour and the no-provider path, and keeps the study-mode policy enforced on every AI surface.
---

# Assistance & providers

## When this applies
Changes to `crates/tutor-llm/chat.rs` (providers, streaming), `policy.rs`,
`desktop/src/assistant.ts`, `desktop/src/edit.ts` ("Edit with me"), or the
`assistant_chat_stream`/`assistant_cancel`/`study_policy`/`list_providers` commands.

## Inputs
The active mode (`localStorage["dxtutor.mode"]` → `Mode::parse`), the provider id, and the
message history (without the empty streaming placeholder).

## Invariants you must preserve
0. **Workspace-aware, not a generic chat.** In project mode the assistant is grounded in
   the OPEN project: `buildWorkspaceContext()` sends root + `workspace_tree` + active file +
   selection, and the context is inspectable (the chip). For file/folder actions it emits a
   single ```dxaction``` block the user approves; the IDE performs it via `workspace_action`,
   which is **contained under the workspace root** (`contained_path` refuses `../` escapes).
   Never answer a "create a folder" request with OS shell instructions.
1. **Policy is backend-decided.** `assistant_chat_stream` derives `policy_for(mode, step)`;
   in study mode it prepends the tutor directive and routes the chat as a tutor. Unknown
   mode → study (fail closed). Study mode does not offer dxactions (tutor routing).
2. **Interruptibility.** Pause/cancel invalidates the generation; late fragments after a
   cancel are ignored (`requestId` guard). On resume, re-read the buffer and preserve
   manual edits. Distinguish a provider with remote cancellation from one interrupted
   locally by invalidating the generation.
3. **No-provider path works.** Offline/no key must degrade honestly, never crash.
4. Capabilities are advertised honestly per provider (what streams, what is gated).

## Steps
1. Make the change; keep the `requestId` the single source of truth for "is this stream
   still mine".
2. For a new provider, wire its streaming adapter and add it to the gated list + capability
   report; verify the mechanism before announcing it.
3. Pass the active mode on every `assistant_chat_stream` call.

## Commands (verified)
```bash
cargo test -p tutor-llm --lib               # providers + policy (offline)
( cd desktop && npm run build )
# Live provider runs are separate and identified as such:
#   Ollama/Qwen3 first; others need a key in AI settings / env.
```

## Expected evidence
Ask "write the whole function", switch surface, repeat — in study mode no path yields the
final body or writes the buffer. Pause mid-stream, edit, resume without losing work. A
provider failure surfaces as `llm://error`, not a hang. Mark live-model runs separately
from offline/fake-provider runs.

## On failure
If the chat solves in study mode, check that `assistant.ts` sends `mode` and that
`assistant_chat_stream` prepends the directive when `policy.chat_is_tutor`. If a late token
appears after cancel, the `requestId` check in the `llm://token` listener is missing.

## Exercised
Policy enforcement landed in P0-2 (commit `b24b538`); `assistant.ts` sends the active mode.
