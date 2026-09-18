# Bot delegation incident

Investigation: 2026-09-16. Session: `a9ecfdf7-91a7-4b7f-aacc-bbd83a20d6d6`.
PR: https://github.com/JairEsk/go-calendar/pull/1.
The recorded reviewer is `@babaspr`, not `@bobopr`.

## Evidence from the original run

- Read the production SQLite database read-only; did not edit its history or queue.
- The host used Gemini (`gemini-subscription`, `gemini-3.8-flash-high`).
- After its delegation, the polling turn used the reviewer's Claude subscription
  (`claude-subscription`, `claude-sonnet-5`). No switch back to Gemini occurred.
- The queue named the reviewer in `as_bot_id`. It was eventually stopped, leaving
  `state=failed`, `error=Stopped.`.
- Both live rendering and the cancellation persistence path lost guest identity,
  so this guest turn appeared as Roxy during execution AND after stopping.
- The self-invocation error is emitted when the effective bot actor calls itself.
  It previously recommended queueing more work rather than identifying the mistake.

The user's observation that the text sounded like Roxy was correct: the guest
continued the host's orchestration instead of accepting its review assignment.

## Separate subscription issue

The pinned CLIProxyAPI v7.2.112 Claude OAuth cloaking path rewrites application
system instructions. A real diagnostic with an exact marker in the system message
returned HTTP 200 but said there was no such marker. With
`disable-claude-cloak-mode: true`, two attempts returned HTTP 429. Restoring the
default returned HTTP 200 and again failed the marker check.

The experimental config change was removed from source and the live config.
No credentials were printed. The cause of the 429 is not established; do not ship
the disabled-cloak setting based on these tests. This transport issue is NOT fixed
by the handoff changes below.

### Follow-up: identity refusal on 2026-09-17

The user supplied a screenshot where the guest rejects the assignment as prompt
injection and calls itself Claude Code / Roxy. The running Electron process was
still the earlier build (PID 33292, started at 01:16:57); restarting would load
the new host handoff but would not fix the independent transport failure.

Upstream v7.2.112 `internal/runtime/executor/claude_executor_cloaking.go` makes
the loss explicit: `checkSystemInstructionsWithSigningMode` replaces `system`
with Claude Code's identity and static instructions. For OAuth,
`sanitizeForwardedSystemPrompt` returns three fixed generic sentences instead
of the supplied application prompt. Bot identity, saved role and environment
instructions therefore cannot survive this path as system instructions.

Repeated the diagnostic in two disposable sidecar instances with temporary
copies of the Claude credential, no tools and a fresh marker present ONLY in
the system message. The production config, conversation and repository were
not changed. Temporary credential copies were removed in the runner's finally.

- Cloaking disabled: HTTP 429, `rate_limit_error`, message `Error`.
- Default cloaking control: HTTP 200, but the model said it did not have the
  diagnostic token. Marker preservation failed.

Scratch runner: `test/.out/claude-identity-probe.cjs`; set
`CLAUDE_PROBE_CONTROL=1` for the default-cloaking control. This is evidence of
instruction loss, not proof of the upstream reason for the 429. Do not claim
that a restart, extra user-message reminders, or the queue fix makes Claude
Subscription bot identity reliable. No production workaround was enabled.

## Changes

- Always restate an invited bot's assignment as its final user message, explicitly
  identifying its role in this turn and distinguishing prior participants' actions.
  A generic continue after another assistant's tool history is not a handoff.
- Live automation events and reload snapshots include the effective bot identity.
- Both canvas layouts use that identity for streaming guest headers and avatars.
- Cancellation and exception persistence retain the guest actor instead of falling
  back to the chat owner.
- Self-invocation errors identify the actor and direct it to answer the assigned
  request, not to queue/wait for itself.
- A deleted explicitly invited bot fails rather than silently running as the host.

## Real-model verification

Used isolated temporary Electron databases, the original bot instructions, the
host's first two persisted messages, the original delegation, the existing local
PR checkout and the running Claude subscription sidecar. No new PR, GitHub comment,
commit or push. The checkout remained clean after testing.

1. With inspection-oriented tools exposed, Claude loaded `critical-pr-review`,
   inspected the actual diff and delivered a review attributed to `babaspr`.
2. With the normal tool catalog, it again loaded the skill, inspected the diff,
   and completed a review without polling or invoking itself. It exceeded the
   requested narrow diagnostic scope, claiming its persistent role took precedence;
   do not treat this as proof of reliable instruction precedence or review quality.
3. A one-response control replaced the final assignment with the old generic
   continuation. It also started inspecting a diff in that sample. Therefore the
   original polling failure is not deterministically reproduced; the original
   persisted actor/provider trace, not a deterministic A/B, establishes who ran it.

The diagnostics used bounded requests. Scratch runners are in ignored `test/.out`.

## Continuity check on 2026-09-17

Production history read-only: in Static Zanoba Saint, the host turn reported
implementing and pushing eb7d2fc, followed by a separate leading @babaspr user
request and an attributed re-review. The first request began Hola @babaspr,
which does not route a leading mention. No successful bot_invoke appeared in
those latest turns. This demonstrates host execution and guest review, not the
automatic return chain. The commit itself was not audited during this check.

Added stable-ID history ownership, foreign tool activity as attributed context,
sender attribution for session_manage send, and bounded recent own activity
from other sessions, without transcript copies or changes to the standing role.
An indexed lookup excludes the current/private chat and malformed JSON rows.

Live isolated check: test/.out/bot-continuity-live.ts, claude-sonnet-4-6 through
the running sidecar, the model selected under Gemini subscription. Only
bot_invoke was allowed by the harness; no shell, filesystem or GitHub tools.
The bot used convention COBALTO-17 from its chat, called bot_invoke with roxy,
the host answered the requested textual correction, and a subsequent private
chat turn recalled its role, convention and external finding/source.
Result: LIVE CONTINUITY OK. No production messages or queues were edited.
This was one bounded live scenario, not proof of universal model compliance or
a fix for Claude Subscription system-prompt replacement.

## Automated verification

- `npm run typecheck`
- `npm run smoke:bots`: shared and runtime complete, including guest assignment,
  reload identity, self-invocation and cancelled guest attribution regressions.
- `npm run smoke:diff`: 53 checks including live guests in both canvas layouts.
- `npm run smoke:shared`: 1083 checks.
- `npm run smoke:store`
- Dedicated Electron/Vite UI fixture: a streaming guest in a project chat renders
  `@reviewer`, its response and no horizontal overflow at 1280px.
- `npx electron-vite build`, targeted Prettier checks, `git diff --check`.

The bot runtime smoke previously could exit successfully when its final test window
closed before async runtime assertions completed. It now suppresses that automatic
quit and exits explicitly after the tests, so `BOT RUNTIME OK` must be reached.
