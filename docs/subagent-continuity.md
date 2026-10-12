# Subagent Continuity

`task` delegates to a child session. It is not a persistent bot
handoff. Foreground delegates return into their launching tool call; detached
delegates can outlive the entire launching turn.

## Failure Modes

- Detached completions only wrote `Background done` assistant rows. The active
  model conversation never received them, and an idle parent was never resumed.
- A delta arriving while an automation snapshot was in flight caused the
  renderer to discard the complete snapshot. Child deltas cannot reconstruct a
  missing parent `tool-start`, so the main task card disappeared until persistence.
- Subagent hydration had the same missing-prefix problem, could resurrect a
  completed run, and left stale streaming bubbles when completion happened offscreen.
- Background launches looked completed immediately and did not expose live
  children in the parent chat. Their result rows also lost the launching actor.
- Asynchronous work sent by a general delegate could reply to its temporary
  child chat after that chat had been pruned.
- A delayed task-result refresh could replace a newly saved parent reply with
  an older message list containing only the result cards. This required no reload.
- End-of-turn cleanup deleted completed child chats and cascaded to their full
  transcripts. A later parent turn could delete a detached review that had finished
  since the previous turn, leaving only its final report in the parent.

Window recreation makes recovery important on macOS, where main remains alive
after the last window closes. The fixes are platform-independent; macOS-specific
rendering was not identified as a cause.

## Invariants

- A detached report is persisted before notification. The launching loop consumes
  it at the next safe model boundary, including when it arrived during the final
  response. If that loop has ended, the existing durable queue resumes the
  launching actor, never whichever bot happens to own the chat.
- Pending sibling-result continuations coalesce per actor. Turn ownership still
  prevents concurrent execution. Stop pauses delivery; cancelled delegates do not
  create a continuation. No synthetic user message is added for the nudge.
- IPC snapshots carry a monotonic sequence. Recovery seeds the full prefix and
  replays only newer buffered events. A newer turn/run boundary invalidates the
  snapshot. Running-list restoration also rejects newer terminal updates.
- All transcript reads share one per-chat ordering guard. A persisted reply is
  retained in the renderer until a read confirms its canonical ID; terminal IPC
  events carry the full saved message before the live bubble is cleared.
- Completion never deletes a parent or child session. Full child transcripts
  survive subsequent turns and database reopening, and task cards link to them.
  Only explicit session deletion removes these rows.
- Task cards use live, bounded child previews. `resultFor` links a persisted
  completion to its launch for display only. Replayable model history remains
  unchanged, and a result whose launch is absent remains visible on its own.
- General delegates route asynchronous replies to the durable parent conversation.
  This routing metadata does not grant the delegate the parent's bot identity.
- Required reports travel with continuation prompts, not only in older history,
  so a summary watermark or a narrower context window cannot drop them.

## Regression Checks

- `npm run smoke:subagents`: real Electron/SQLite/harness with a deterministic
  transport, covering two foreground delegates streaming nested tool progress,
  multiple write-capable tasks serialized within a batch and across model steps
  with one parent reply (both omitted `background` and explicit `false`),
  reverse-order completion and parent continuation, mid-turn results, late sibling results,
  guest rename/config, host-in-private-chat, cancellation, failures, and handoffs
  surviving explicit child deletion. Also checks full terminal IPC payloads,
  retained history after follow-ups and database reopen, report delivery after
  compaction/trimming, and sibling results spanning a bot rename. Included in
  the Linux/Windows/macOS CI matrix.
- `npm run smoke:store`: two-task recovery across every catch-up/event split,
  snapshot prefix/tail recovery, terminal races, offscreen
  completion, restored task counts, stale completion refreshes, and display-only
  launch/result projection with stable layout-cache references and fork isolation.
- `npm run smoke:canvas`: includes the subagent UI fixture, with detached progress,
  original-card completion, full saved-child navigation, real cancellation clicks,
  and narrow bot-chat layout.

Local verification used Windows. The new mid-turn regression fails against the
previous harness (two model calls instead of the required third continuation)
and passes with the fix. No real-provider or native macOS verification was run.

An additional old-versus-fixed store probe used identical foreground task data
with only event timing changed. Old code restored both cards when the child delta
arrived after catch-up, but lost both when it arrived during catch-up. Fixed code
restored both cards and their progress in either order. This reproduces an
intermittent missing-card failure, not every possible cause of a stalled model
turn. The no-reload failures below were investigated separately.

## This Conversation

The user's next screenshots supplied a no-reload example from this fix session.
A read-only check of the production database identified the detached
`Review continuation and recovery` task. At inspection it had made 61 completed
model calls over about 45 minutes, with recent usage and no final assistant
message. Its persisted launch card nevertheless said `done`, contained only
`Started ... in the background`, and had no child progress. The running badge
was not evidence of a dead stream: the delegate was genuinely still working.
The parent also incorrectly described the fix as complete before the review returned.

The review subsequently returned five findings. A later read-only check found
its parent `Background done` report, but the child session and full transcript
were gone. That confirmed the automatic cleanup behavior in this conversation
as well. The review findings are now covered: compaction-safe report delivery,
paragraph boundaries, stable projected part references, fork cancellation isolation,
and coalescing by stable actor ID rather than captured username.

This is the separate background visibility path, not the reload race. The
installed 1.0.4 bundle explicitly disabled child forwarding for detached runs.
The fix uses the independent subagent stream to project live progress onto the
launch card. A bounded running-task strip next to the composer keeps unfinished
work discoverable after that card scrolls out of view, with open and cancel
actions. Store and Electron UI checks now cover this no-reload, parent-already-
finished case. The strip reflects actual job lifetime, not the agent's checklist.

This check does not establish that every long-running delegate is making useful
progress, or impose an arbitrary timeout on legitimate unattended work. Nor does
building the worktree replace the running installed app.

## Completion Race

The disappearing-parent case was reproduced by running the actual store handler
with a delayed IPC response: start a result refresh, persist the full parent
answer, then resolve the refresh with its older result-only snapshot. Before the
fix the final visible list lost the parent answer. The regression now also checks
older reads resolving after a newer read retired the saved-message overlay,
terminal events followed by failed reads, and full child transcript preservation.
The screenshot's original project was not found in this local database, so these
reproductions establish matching failure modes, not a forensic recovery of that chat.
