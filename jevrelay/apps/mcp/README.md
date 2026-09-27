# JevRelay MCP

The local MCP server, published as:

```text
@jevrelay/mcp
```

Initial command:

```text
npx @jevrelay/mcp
```

Planned layout:

```text
src/mcp.ts          MCP tools and stdio transport
src/runtime.ts      Jev Script validation and execution
src/auth.ts         OAuth PKCE and OS credential storage
src/relay.ts        authenticated calls to api.jevrelay.com
src/adapters/
  playwright.ts     first adapter
```

This app owns all browser and future desktop execution. Electron is not required.
