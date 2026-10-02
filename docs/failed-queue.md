# Failed Queue Recovery

Queued acceptance is not delivery. Cross-session tool results carry the same
queue ID as the destination banner, plus an explicit delivery receipt:
enqueued, waiting_behind_failure, running, failed, cancelled, completed, or
discarded. A missing queue row alone never proves completion.

A failed or cancelled request stays durable until Retry or Discard. Automated
requests behind it wait. Existing user-task bypass remains available: a newer
user task can run without clearing the automated blocker. Explicit Stop aborts
the turn and pauses automatic processing; Retry and Discard resume processing.
Legacy failures containing Stopped. remain Failed because that text alone does
not establish who cancelled the request. App-shutdown interruptions remain
Failed, and are never replayed automatically.

User-origin failures recover only in their composer row, with inline discard
confirmation. Automated failures use the banner; these surfaces never overlap.
Bot tools can retry after reviewing newer work using `queue_manage update` with
`retry_after` equal to the `retryAfter` token returned by read/list.

Legacy blocked rows get an upgrade-time transcript baseline. Restart marks
interrupted requests failed and checkpoints their own partial output atomically.
Receipts store only status fields and are refreshed on queue transitions, not
on message notifications. Historical completed tools without a receipt remain
unknown instead of claiming they are still enqueued.

Retry keeps the queue ID, FIFO position, prompt, images, and existing prompt
message. It is not an exactly-once guarantee for tool side effects that happened
before interruption. Review partial work first. If newer session messages exist,
the banner requires explicit confirmation tied to that version of the transcript.
Main rejects an outdated confirmation and blind editor retries. Discard requires
confirmation, preserves work already performed, and wakes the next pending item;
the existing durable claim and session lock prevent duplicate concurrent delivery.

Preferred operation: complete one task, review its result and changes, then send
the next task. If later work already handled a failed assignment, prefer Discard
over replaying the old prompt.

## Deterministic Regression

Run `npm run smoke:queue`. It uses a temporary database, never the user's data.
The original T0 commit intentionally failed because an automated failed head was
hidden, while B remained pending. The final test exercises the banner contract,
recovery, cancellation, honest receipts, and stale retry protection.

## Manual Check

1. Send A to another session, stop its execution, then send B to that session.
2. Open the destination. Check the persistent blocker, source, error, ID, and
   pending count without opening any queue inspector.
3. Click Discard. Check that nothing runs before Confirm discard.
4. Confirm. B starts without restarting the app and produces one response.
5. Repeat with Retry: confirm the same ID and no second prompt bubble. Run a
   newer task before retrying A to check the stale-work warning.
6. Open the origin: enqueued/waiting must not say started or replied. Compare
   its queue ID with the destination. Completed requires a durable receipt.

Phone recovery controls and broader Calling/turn desynchronization work are
outside this desktop sprint. They should not be inferred as fixed by this UI.
