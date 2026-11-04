# JevRelay

JevRelay is an open source local runtime for AI-created browser automations.

Domain: `jevrelay.com`

## Two Repositories

Use two repositories because only the inference provider is private.

### 1. `jevrelay` - Public

Everything users install and run locally:

```text
jevrelay/
  apps/
    mcp/              local MCP server and CLI
  packages/
    runtime/          script execution
    script/           schema and types
    playwright/       browser adapter
    providers/        OpenRouter and JevRelay adapters
  examples/
    play-video.json
```

Open source this entire repository.

### 2. `jevrelay-provider` - Private

Only our optional hosted inference provider:

```text
jevrelay-provider/
  POST /v1/decide
```

Deploy it at:

```text
api.jevrelay.com
```

It accepts a typed decision request, calls Jev, and returns the typed answer. It does not run scripts, browsers, MCP, Playwright, desktop actions, or computer controls.

## Provider Choice

JevRelay does not force users to buy inference from us.

During local setup:

```text
Choose an inference provider:
1. OpenRouter
2. JevRelay
```

Then the user supplies that provider's API key. Choosing OpenRouter does not require a JevRelay account and sends no inference request through our server.

```text
OpenRouter selected
-> store OPENROUTER_API_KEY locally
-> decision steps call OpenRouter

JevRelay selected
-> create a key on jevrelay.com
-> store JEVRELAY_API_KEY locally
-> decision steps call api.jevrelay.com directly over HTTPS
```

The runtime uses one provider interface:

```ts
interface DecisionProvider {
  decide(request: DecisionRequest): Promise<DecisionResponse>
}
```

Provider adapters translate the same typed decision into the provider's request format.

## API Keys

OAuth is not required for the MVP.

Users configure their provider with a local interactive command:

```text
npx @jevrelay/mcp setup
```

The command stores the selected provider and API key in the operating system credential store. Environment variables are also supported for servers and development:

```text
JEVRELAY_PROVIDER=openrouter
OPENROUTER_API_KEY=...
```

or:

```text
JEVRELAY_PROVIDER=jevrelay
JEVRELAY_API_KEY=...
```

Do not ask users to paste API keys into an MCP tool. Tool arguments can enter the AI transcript and logs.

A JevRelay API key can initially be created on `jevrelay.com` and pasted into local setup. Only the private inference service and its small key-management page need accounts. The MCP server does not need login, sessions, OAuth, or account management.

## How It Works

```text
Claude / ChatGPT / Roxy
-> open source @jevrelay/mcp
-> open source runtime
-> Playwright actions run locally
-> selected inference provider handles only explicit decisions
-> runtime verifies the result locally
```

Browser cookies, scripts, screenshots, and computer access stay on the user's machine.

## MCP Tools

Keep the initial MCP surface small:

```text
jevrelay_validate
jevrelay_run
jevrelay_status
jevrelay_stop
```

Provider setup is a local CLI command, not an MCP tool.

`jevrelay_run` accepts a Jev Script and inputs. One script can execute many local Playwright actions without an AI round trip for every click.

## Jev Scripts

A Jev Script is validated data, not arbitrary JavaScript or shell code.

```json
{
  "version": 1,
  "name": "play-video",
  "permissions": {
    "origins": ["https://www.youtube.com"]
  },
  "steps": [
    {
      "action": "browser.goto",
      "url": "https://www.youtube.com"
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
        "question": "Which video best matches the request?",
        "optionsFrom": "videos.id",
        "saveAs": "videoId"
      }
    },
    {
      "action": "browser.click",
      "target": { "id": "${vars.videoId}" }
    }
  ]
}
```

Every action must be implemented by an installed local adapter and pass validation.

See [`packages/script/jev-script-v1.md`](packages/script/jev-script-v1.md) and [`packages/script/jev-script-v1.schema.json`](packages/script/jev-script-v1.schema.json).

## Fast MVP

Build only this flow:

```text
install @jevrelay/mcp
-> choose OpenRouter or JevRelay
-> store the provider API key locally
-> submit play-video.json
-> validate locally
-> run Playwright locally
-> call the selected provider for one bounded decision
-> click and verify locally
-> return one structured result
```

Keep the browser warm during a run. Use DOM and accessibility data instead of screenshots. Put waits, retries, and assertions in the local runtime.

## Not Yet

Do not build these until the browser MVP works:

- OAuth.
- Electron app.
- Windows or macOS desktop control.
- Game automation.
- Visual script editor.
- Marketplace.
- More inference providers.

A future Electron or tray app can provide local setup, permissions, logs, and a stop button while reusing the same open source runtime.
