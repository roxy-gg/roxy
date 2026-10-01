# JevRelay MCP

The open source local MCP server and setup CLI, published as:

```text
@jevrelay/mcp
```

Commands:

```text
npx @jevrelay/mcp setup
npx @jevrelay/mcp
```

Planned layout:

```text
src/mcp.ts          MCP tools and stdio transport
src/cli.ts          local provider setup
src/config.ts       provider choice and credential-store access
```

The setup command asks the user to choose OpenRouter or JevRelay and stores the API key in the OS credential store. API keys are never accepted through MCP tool arguments.

The runtime, Playwright adapter, script package, and provider adapters remain separate public workspace packages in the same repository.

Electron is not required.
