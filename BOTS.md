# Bots

Bots are persistent, top-level chats, not project sessions or temporary subagents.
Create one below **New project**, pick a unique username, and describe its role in
chat. The bot can save that role with `bot_manage`. Its model, conversation,
tools, services, browser, and queue use the existing session harness.

## Collaboration

Each actor keeps its own saved role, model configuration and stable bot ID.
Other participants' messages and tool activity are attributed background, not
replayed as the current actor's native assistant/tool history. Renaming a bot
does not turn its old messages into another participant's work.

Invited bots receive bounded context from their own chat. Both private and
invited turns also receive up to four text excerpts of their own contributions
in other sessions, with source session/message IDs. `bot_manage read` exposes
these excerpts too. This is recent activity, not exhaustive memory or proof of
completion; the bot must inspect the source for details or current status.
No transcript is copied, no new turn is scheduled, and task history never
automatically replaces the saved role. Deleting a source removes that activity.

- All project user messages reach Roxy first by default (including Enter in the
  composer). Private bot chats stay with their owner. No parser routes messages
  based on the presence or position of `@`.
- Mentions highlight existing bots and Roxy only. Unknown handles and scoped
  packages such as `@modelcontextprotocol/sdk` are plain text, never send errors.
- The composer offers an explicit **Send to @username** action when a known bot
  is the clear target (one known `@mention`, or the user picked one among several).
  That queues the prompt so only that collaborator answers as a guest in the
  shared project session — the same `sourceChatId` / `asBotId` / `recipientId`
  contract as `bot_invoke`. With several known `@bots` and no pick, the UI asks
  which one; it never silently routes to the wrong bot.
- The model interprets intent: a direct `Hola @reviewer` calls `bot_invoke`
  without an announcement; `implement this, then ask @reviewer` keeps the work
  with Roxy until its prerequisites are complete. Questions about a bot stay
  with Roxy. This is model behavior, not a deterministic language classifier.
- Explicit tool handoffs retain a stable destination across renames and retries.
  User queues never select a guest, including queues left by the old mention
  router. Failed entries remain paused for deliberate retry or removal.
- Agents use `bot_invoke` to delegate explicitly. The response is persisted in
  the caller's transcript. A bot can hand actionable follow-up work back to the
  project host with `bot_invoke({ bot: 'roxy', prompt: '...' })`. Roxy runs after
  the bot's turn, using the project session's model, mode and workspace. A prose
  `@Roxy` mention alone does not schedule work. There is no automatic return turn
  for a completed result with no follow-up task.
- Roxy is a reserved host destination, not a registered bot. A bot can invoke
  Roxy inside its private chat using app inference defaults and that chat's
  workspace. Work for a different project requires `session_manage send` with an
  identified session; the app never guesses which project should receive changes.
- An invited bot answers as itself: its own identity, instructions, model, mode,
  thinking effort, and context budget, plus a bounded text-only slice of its own
  chat as background. The host session still owns the transcript, workspace, and
  queue.
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

Persistent identities, standing roles and attributed handoffs remain separate
from delegation. Schema v25's destination column remains internal to explicit
tool handoffs; v26 clears obsolete auto-routed user destinations without retrying
work. Tools and scheduled jobs own their destinations, not mentions.

Run `npm run smoke:bots` for scheduling/mention unit checks and isolated Electron
runtime tests covering migration, CRUD, queue ownership, failures, handoffs, and
the real harness with a deterministic model transport. No live model credentials
are used by these tests.
