# Delivery Reliability Audit

## Confirmed Defects

- Renderer enqueue created an optimistic `pending` row for every private bot
  send. Main then broadcast another pending snapshot before its next-pass claim.
  Both created a waiting transition for work which could start immediately.
- `refreshQueue` and `selectChat` could publish old reads after a newer automation
  mirror. The enqueue acknowledgement also appended its original item regardless
  of whether main had already consumed it. A stale queue card could therefore
  remain while backend activity was idle.
- Queue claim wrote SQLite after acquiring an in-memory turn, outside cleanup.
  A thrown claim write leaked the reservation, blocking future prompts with no
  live automation snapshot. The regression injects a SQLite trigger failure.
- Completion, mutation and subagent release did not uniformly wake consumption;
  most recovery depended on the one-second scheduler. Normal project sends also
  used a separate renderer-owned preflight/persistence path, creating admission
  races against automated results and incoming prompts.
- Pending collaborator requests already had transcript rows. History rebuilding
  included them before admission. Request restoration skipped the current request
  if its text occurred anywhere in history, including before a returned result.
  This could give the model the wrong final instruction. Restated image-bearing
  requests also need their images, not just text.

These are code/test findings, not a claim that the specific reported screenshot
had any one backend state. No production chat/database was read or modified.

## Contract

One main-process admission policy applies to ordinary model sends, tool sends,
explicit queues and scheduler deliveries. An eligible idle request is claimed
synchronously, persisted to history, and announced as starting. Waiting cards
describe actual waiting, not internal durability. No new tool option is needed.

At most one claim per chat, at most four automated targets globally. FIFO uses
the existing `(created_at, rowid)` order. Existing exceptions remain: failed or
future machine work blocks automation but can be passed by the first user item;
failed/future user heads cannot be passed. Stop remains a deliberate pause;
new explicit sends or edits resume, but automatic results do not override Stop.

`bot_invoke` stays in the caller's transcript and waits for caller release.
`session_manage send` starts another eligible session immediately, preserving
reply actor and hop metadata. Returned answers append and continuations queue
without cancelling, releasing or replacing the source's active turn.

Unchanged retries reuse the original prompt message ID. Edited failed requests
append a correction with the original routing and images. Starting/running rows
are immutable, survive reload, and become failed after restart rather than
replaying uncertain external effects. Exactly-once external tool effects are not
promised. Local `!` commands and the disconnected project demo retain their
existing renderer behavior; normal provider-backed messages no longer use it.

## Coverage

`test/queue-delivery.ts` exercises real DB, IPC registration, tools, session
harness, and a scripted model transport. Its periodic drain is suppressed so
release/mutation tests cannot pass accidentally on the safety tick.

| Scenario                          | Evidence                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User to bot/project idle and busy | Synchronous claim, no waiting row, three images, FIFO, one prompt per delivery                                                                                 |
| Independent sessions              | Four concurrent targets; fifth starts on released capacity                                                                                                     |
| Bot to bot/Roxy                   | Caller reservation prevents start; release starts named actor after caller history                                                                             |
| Bot to project                    | Immediate send; real new git worktree; returned result with queued user prompt ahead of continuation                                                           |
| Subagent completion               | Pending follow-up starts on run completion                                                                                                                     |
| Queue create/update/delete        | Tool paths, failed-head retry/removal, original images and prompt identity                                                                                     |
| Timing                            | Future user blocks FIFO; hidden machine delay permits user; timestamp update wakes; explicit due clock                                                         |
| Failures/cancel                   | Claim write failure releases; model error fails; Stop aborts; deliberate resume                                                                                |
| Restart                           | SQLite close/reopen, pending resumes, uncertain starting fails with preserved attachments                                                                      |
| Renderer races                    | Executed store action rejects late pending snapshot after newer empty read                                                                                     |
| Integrated UI                     | Real composer button, preload, IPC and SQLite; DOM mutation observation of zero idle waiting panels; busy queue drains; reload mid-start; 390px overflow check |

Existing `smoke:bots` supplies migration, schedule coalescing/force-run/deletion,
host/guest config and identity, hop limits, low-level local turn ownership,
collaborator edits and cancellation coverage.

## Boundaries

- No live paid model calls or reproduction against the user's personal queue.
- Electron uses a deterministic provider, not a packaged installer or a phone
  relay connection. Remote waiting filtering is changed, but phone reconnect
  rendering is not exercised end-to-end here.
- Restart is a database close/reopen plus worker startup, not an OS kill during
  a non-idempotent external tool action.
- Worktree creation is real; long project setup scripts are not exercised.
- Attachment-forwarding, avatar attribution, and subagent-continuity fixes from
  main are integrated. Existing `image_refs` resolve before admission; their
  copied images, capability checks, and safe tool acknowledgements are preserved.
- Sequence-based stream recovery shares the unified transcript loader with queue
  revision guards. Phase updates neither discard the snapshot prefix nor revive
  stale starting state. Terminal events retain the fully persisted reply.
- Merge regressions cover forwarded images on immediate project sends, deferred
  bot/Roxy handoffs and explicit future delivery, alongside the upstream image
  and subagent suites. No other worktrees were modified.
