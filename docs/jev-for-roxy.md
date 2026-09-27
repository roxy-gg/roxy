# Jev for Roxy

Jev should make small decisions for Roxy.

It should not generate scripts or control the computer directly. A larger model can generate a declarative Jev Script, but the local runtime validates and executes it. Jev only chooses between known options at explicit decision steps.

See [`jevtools/`](../jevtools/README.md) for the proposed local MCP runtime and hosted inference relay.

Roxy executes the tools. Jev chooses between known options.

## Use Case 1: Browser Automations

Let users save and replay browser workflows.

### Tool Calls

```text
automation_save
automation_run
browser_wait
browser_extract
browser_assert
jev_decide
```

### Example

User says:

> Find the newest Roxy video and play it.

Roxy would:

1. Open the video page.
2. Extract the available video IDs and titles.
3. Ask Jev which ID best matches "newest Roxy video."
4. Click that video's play button.
5. Check that the video is playing.

### Prompt Change

Instead of asking the LLM to decide every click:

```text
Look at this page and decide what to click next.
```

Roxy gives Jev a small choice:

```text
Which video matches the request?

Options:
- video_1: Roxy Setup Guide
- video_2: Roxy September Update
- video_3: Cloudflare Tutorial
```

### Flow

```text
User request
-> Roxy runs browser steps
-> Jev chooses a known video ID
-> Roxy clicks it
-> Roxy verifies playback
```

## Use Case 2: Skill And Tool Selection

Use Jev to select the best Roxy skill or tool before calling the main LLM.

### Tool Call

```text
jev_decide
```

### Example

User says:

> Make this modal animation feel faster.

Jev chooses from:

```text
transitions-dev
transitions-polish
review-animations
no-skill
```

Roxy loads only `transitions-polish`.

### Prompt Change

Today, the main LLM may receive many skill descriptions.

With Jev, the main LLM receives only the selected skill:

```text
Use the transitions-polish skill for this request.
```

### Flow

```text
User request
-> Jev selects a skill
-> Roxy loads that skill
-> Main LLM completes the work
```

## Use Case 3: Bot Automations

Let bots run saved workflows without asking an LLM to recreate every step.

### Tool Calls

```text
bot_schedule
automation_run
jev_decide
bot_invoke
```

### Example

A deploy bot runs every morning:

1. Open the deployment dashboard.
2. Extract deployment status.
3. Ask Jev to classify it as `healthy`, `warning`, or `failed`.
4. Do nothing when healthy.
5. Invoke the bot when warning or failed.

### Prompt Change

Instead of this scheduled prompt:

```text
Open the dashboard, inspect everything, and decide what to do.
```

Schedule a saved automation:

```text
Run automation "check-deploy-status".
Only invoke the deploy bot for warning or failed results.
```

### Flow

```text
Bot schedule
-> Saved automation runs
-> Jev classifies the result
-> Bot is invoked only when needed
```

## What To Build First

Build Use Case 1 first.

Minimum version:

1. Add `jev_decide`.
2. Add `browser_wait`, `browser_extract`, and `browser_assert`.
3. Add `automation_save` and `automation_run`.
4. Demo one workflow that finds and plays a video.

Do not start with global mouse and keyboard control. Browser actions are safer and more reliable.

## Jev Limits

- Jev only reads text and structured text.
- Jev cannot read screenshots or video.
- Jev should choose from known options.
- Roxy should execute and verify every action.
- Risky actions still require normal Roxy safety checks.

## References

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/primitives
- https://docs.typesafe.ai/cookbooks/function_calling
- https://docs.typesafe.ai/cookbooks/skill_suggestion
