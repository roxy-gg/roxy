# JevTools Local

Published package name:

```text
@jevtools/mcp
```

This package will contain:

```text
src/mcp.ts          local MCP tools and stdio transport
src/runtime.ts      Jev Script validation and execution
src/auth.ts         OAuth PKCE and OS credential storage
src/relay.ts        authenticated calls to JevTools Relay
src/adapters/
  playwright.ts     first adapter
```

The initial command should be:

```text
npx @jevtools/mcp
```

Electron is not required. A future desktop UI must reuse this runtime rather than reimplementing automation.
