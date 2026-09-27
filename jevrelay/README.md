# JevRelay

JevRelay lets Claude, ChatGPT, Roxy, and other MCP hosts create and run fast local automations.

Domain: `jevrelay.com`

## One Repository

Create one GitHub repository named `jevrelay`:

```text
jevrelay/
  apps/
    mcp/          local MCP server and Playwright runtime
    api/          hosted OAuth and Jev inference relay
  packages/
    script/       shared Jev Script schema and types
  examples/
    play-video.json
```

That is all the MVP needs.

Do not create separate client, server, protocol, Playwright, desktop, or Electron repositories. Split repositories only if separate teams or release cycles create a real need later.

## How It Works

```text
Claude / ChatGPT / Roxy
-> @jevrelay/mcp on the user's computer
-> Playwright runs browser actions locally
-> api.jevrelay.com is called only for Jev decisions
-> local runtime verifies the result
```

The AI creates a declarative Jev Script. The local MCP server validates and runs it. Jev only chooses between known options at explicit `decide` steps.

## Two Deployables

The single repository produces two things.

### Local MCP

Published as:

```text
@jevrelay/mcp
```

Run with:

```text
npx @jevrelay/mcp
```

It contains:

- The MCP tools.
- The Jev Script runtime.
- The Playwright adapter.
- OAuth login.
- Local permissions, logs, cancellation, retries, and verification.

Browser cookies and computer access stay local.

### Hosted API

Deployed at:

```text
api.jevrelay.com
```

It contains:

- OAuth and accounts.
- The TypeSafe Jev API key.
- Jev inference routing.
- Usage limits, billing, and markup.

It never runs browser or desktop actions.

## MCP Tools

Keep the initial surface small:

```text
jevrelay_auth
jevrelay_validate
jevrelay_run
jevrelay_status
jevrelay_stop
```

`jevrelay_run` accepts a Jev Script and inputs. One script can run many local Playwright actions, avoiding an AI round trip for every click.

## OAuth

```text
1. User installs @jevrelay/mcp.
2. jevrelay_auth opens jevrelay.com.
3. User signs in using OAuth PKCE.
4. The callback returns to the local MCP process.
5. The refresh token is stored in the OS credential store.
6. The MCP process uses short-lived tokens with api.jevrelay.com.
```

The local package never receives the upstream TypeSafe API key.

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

Every action must be implemented by an installed adapter and pass local validation.

See [`packages/script/jev-script-v1.md`](packages/script/jev-script-v1.md) and [`packages/script/jev-script-v1.schema.json`](packages/script/jev-script-v1.schema.json).

## Fast MVP

Build only this flow:

```text
install @jevrelay/mcp
-> sign in
-> submit play-video.json
-> validate locally
-> run Playwright locally
-> call JevRelay once for a bounded decision
-> click and verify locally
-> return one structured result
```

Keep the browser warm during a run. Use DOM and accessibility data instead of screenshots. Put waits, retries, and assertions in the local runtime.

## Not Yet

Do not build these until the browser MVP works:

- Electron app.
- Windows or macOS desktop control.
- Game automation.
- Visual script editor.
- Marketplace.
- Additional repositories.

A future Electron or tray app can provide login, permissions, logs, and a stop button while reusing the same local runtime.
