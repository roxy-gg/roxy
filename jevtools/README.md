# JevTools

JevTools lets Claude, ChatGPT, Roxy, and other MCP hosts create and run fast local automations.

The AI writes a small declarative Jev Script. JevTools validates it, executes normal actions locally, and calls Jev only for bounded decisions.

```text
Claude / ChatGPT / Roxy
-> local JevTools MCP server
-> Playwright or an OS adapter
-> JevTools Relay only when a decision needs inference
```

## What We Ship

### 1. JevTools Local

One installable package:

```text
@jevtools/mcp
```

It runs on the user's computer and provides:

- A local MCP server over stdio.
- A Jev Script validator and runtime.
- A Playwright browser adapter.
- OAuth login to the JevTools Relay.
- Local execution logs, cancellation, and permission checks.
- Windows UI Automation and macOS Accessibility adapters later.

The browser, cookies, desktop state, and input control stay local.

### 2. JevTools Relay

One hosted service operated by us. Users do not install it.

It provides:

- OAuth and account management.
- A relay to the TypeSafe Jev API.
- Usage limits, billing, and our markup.
- Model routing and version control.
- Audit metadata without browser credentials or cookies.

The TypeSafe API key stays on our server. The local package receives a short-lived JevTools access token.

Do not call these packages `JevClient` and `JevServer`. In MCP terminology, the local program is already an MCP server. `JevTools Local` and `JevTools Relay` make the boundary clearer.

## OAuth Flow

```text
1. User installs @jevtools/mcp.
2. User or MCP host calls jevtools_auth.
3. JevTools opens the browser with an OAuth PKCE login URL.
4. Login returns to a loopback URL on the user's computer.
5. JevTools stores the refresh token in the OS credential store.
6. JevTools calls the relay with short-lived access tokens.
7. The relay meters the Jev inference and returns the typed answer.
```

The local runtime never receives our upstream TypeSafe API key.

## MCP Tools

Keep the first MCP surface small:

```text
jevtools_auth
jevtools_validate
jevtools_run
jevtools_status
jevtools_stop
```

`jevtools_run` receives a Jev Script plus inputs. The script can contain many local actions, so the MCP host does not pay one model round trip for every click.

## Jev Script

A Jev Script is data, not arbitrary JavaScript or shell code.

```json
{
  "version": 1,
  "name": "play-video",
  "permissions": {
    "origins": ["https://www.youtube.com"]
  },
  "inputs": {
    "query": "Roxy"
  },
  "steps": [
    {
      "action": "browser.goto",
      "url": "https://www.youtube.com"
    },
    {
      "action": "browser.fill",
      "target": { "role": "combobox", "name": "Search" },
      "value": "${input.query}"
    },
    {
      "action": "browser.press",
      "target": { "role": "combobox", "name": "Search" },
      "key": "Enter"
    },
    {
      "action": "browser.extract",
      "target": { "selector": "ytd-video-renderer" },
      "fields": ["id", "title"],
      "saveAs": "videos"
    },
    {
      "decide": {
        "state": "${vars.videos}",
        "question": "Which video best matches the user's request?",
        "optionsFrom": "videos.id",
        "saveAs": "videoId"
      }
    },
    {
      "action": "browser.click",
      "target": { "id": "${vars.videoId}" }
    },
    {
      "action": "browser.assert",
      "target": { "selector": "video" },
      "state": "playing"
    }
  ]
}
```

The AI can create this script, but it cannot invent new runtime powers. Every `action` must match an installed adapter operation and pass validation.

See [`protocol/jev-script-v1.md`](protocol/jev-script-v1.md) and the machine-readable [`protocol/jev-script-v1.schema.json`](protocol/jev-script-v1.schema.json) for the initial contract.

## Fast Path

The speed comes from where work runs:

```text
Local action
-> local action
-> local action
-> one batched Jev decision when needed
-> local action
-> local verification
```

Rules for keeping it fast:

- Run Playwright locally.
- Keep the browser process and context warm during a run.
- Compile and validate the script once before execution.
- Use DOM and accessibility data instead of screenshots where possible.
- Call the relay only for `decide` steps.
- Batch independent Jev questions into one request.
- Put retries, waits, and assertions in the local runtime.
- Return one structured result to the MCP host.

MCP stdio is not the bottleneck. Repeated LLM and screenshot round trips are.

## Electron

Do not start with Electron.

The foundation should be a headless Node.js MCP server and runtime. This works with Claude Desktop, Claude Code, ChatGPT-compatible MCP hosts, Roxy, and other clients without a separate app.

Add an Electron or native tray app later only for:

- Login and account status.
- Permission management.
- Run history and live logs.
- A large stop button.
- macOS Accessibility permission onboarding.

The UI should call the same local runtime. It should not contain a second automation engine.

## Adapter Order

1. Playwright browser adapter.
2. Windows UI Automation adapter.
3. macOS Accessibility adapter.
4. Optional screen and native input fallback.
5. Game-specific adapters.

Desktop adapters belong in JevTools Local because they must access the user's machine. The relay only performs inference and account operations.

Games need a different execution loop. MCP can start and stop a game script, but it should not carry every frame or input. Real-time observation and controls must remain local, with Jev used for occasional high-level bounded decisions.

## MVP

Build one vertical slice:

```text
install @jevtools/mcp
-> OAuth login
-> AI submits play-video.json
-> local validator approves it
-> Playwright runs locally
-> one decision is sent through the relay to Jev
-> local runtime clicks and verifies playback
-> MCP returns the result and usage
```

Do not add desktop control, games, a visual editor, a marketplace, or Electron until this flow is reliable.
