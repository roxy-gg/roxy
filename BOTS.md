# Bots

Bots are persistent, top-level chats, not project sessions or temporary subagents.
Create one below **New project**, pick a unique username, and describe its role in
chat. The bot can save that role with `bot_manage`. Its model, conversation,
tools, services, browser, and queue use the existing session harness.

## Collaboration

- A leading `@username` in a session sends that request and a bounded slice of
  session context to the bot's own chat. Its attributed answer appears back in
  the source session. Mid-sentence mentions do not redirect a user's request.
- Agents use `bot_invoke` to delegate explicitly. The response is persisted in
  the caller's transcript and a continuation is queued for the caller.
- `project_list` and `session_manage` discover projects, create/read/update/delete
  project sessions, and send prompts to them. New sessions honor workstream
  isolation. Busy sessions cannot be deleted through these tools.
- `queue_manage` creates, lists, reads, edits/retries, and deletes pending
  messages in any session or bot chat. It supports delayed delivery.
- Handoffs and continuations carry a maximum eight-hop budget. A result does
  not recursively reply to its sender. Each target has a maximum 100 queued
  messages and at most one active turn; automation runs at most four targets
  concurrently.

## Scheduling

`bot_schedule` and bot settings support multiple jobs per bot:

- Intervals of at least one minute.
- Five-field cron expressions with an explicit IANA timezone.
- Explicit epoch-millisecond timestamps.
- Optional remaining-run limits and pause/resume.

The main process atomically enqueues each due prompt and advances its schedule.
No renderer needs to be open. **Roxy must still be running; this is not an OS or
cloud scheduler.** Missed interval/cron beats coalesce into one delivery after
startup. Explicit timestamps remain distinct deliveries.
Pausing affects future beats; already queued messages remain editable in the
queue. Deleting a schedule cancels its not-yet-started pending deliveries.

The main process owns queue consumption for desktop, phone, bots, and scheduled
jobs. Failed requests remain in the queue with an error and block later work
until edited/retried or removed. Stop pauses draining. Interrupted deliveries
are marked failed on startup rather than replaying potentially non-idempotent
tool actions. There is no exactly-once guarantee for external side effects.

New bots get private working folders under the app's user-data directory, with
the full existing harness and its normal tool restrictions. They coordinate
project work through sessions rather than silently borrowing the currently open
project. Migrated loops retain their working directory so existing tasks keep
working, but appear in the top-level bot navigation.

## Migration And Checks

Schema v24 migrates existing loops to bots and interval jobs, retaining chat IDs,
transcripts, inference settings, workspace paths, pending messages, enabled
state, and schedule times. Colliding legacy names get unique usernames. The old
loop scheduler, tools, IPC, and navigation are removed.

The useful ideas from PR #91 are preserved: persistent identities, standing
roles, leading-mention routing, and attributed handoffs. Channel membership and
prose-scanning automatic handoffs are deliberately not required. Bots always
run in their own conversation; explicit tools handle agent-to-agent delegation.

Run `npm run smoke:bots` for scheduling/mention unit checks and isolated Electron
runtime tests covering migration, CRUD, queue ownership, failures, handoffs, and
the real harness with a deterministic model transport. No live model credentials
are used by these tests.
