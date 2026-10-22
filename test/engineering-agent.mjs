import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
await build({
  entryPoints: ['test/engineering-agent.ts'],
  outfile: 'test/.out/engineering-agent.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  plugins: [
    {
      name: 'native-runtime-boundary',
      setup(plugin) {
        plugin.onResolve({ filter: /services\/cheat$/ }, () => ({
          path: 'cheat',
          namespace: 'cheat-test'
        }))
        plugin.onLoad({ filter: /.*/, namespace: 'cheat-test' }, () => ({
          contents: `
            export const cheatTurn = async () => globalThis.__nativeTest.cheat;
            export const closeCheatSession = () => {};
            export const runCheatTool = async (name, input, sessionId, actor) => {
              globalThis.__nativeTest.executions.push({ name, input, sessionId, actor });
              return { ok: true, output: 'cheat handler result' };
            };
          `
        }))
        plugin.onResolve(
          { filter: /services\/engineering-tools$|^\.\/engineering-tools$/ },
          () => ({ path: 'engineering', namespace: 'native-test' })
        )
        plugin.onResolve({ filter: /services\/mcp$/ }, () => ({
          path: 'mcp',
          namespace: 'mcp-test'
        }))
        plugin.onLoad({ filter: /.*/, namespace: 'mcp-test' }, () => ({
          contents: `
      ${[
        'mcpToolTitle',
        'loadWorkspaceMcpServers',
        'ensureMcpConnected',
        'mcpToolSchemas',
        'mcpInstructions',
        'isMcpTool',
        'callMcpTool',
        'reconnectMcpServer',
        'disposeConnection',
        'mcpServerSummaries'
      ]
        .map(
          (name) => `export const ${name} = (...args) => globalThis.__nativeMcp.${name}(...args);`
        )
        .join('\n')}
    `
        }))
        plugin.onLoad({ filter: /.*/, namespace: 'native-test' }, () => ({
          contents: `
      export const engineeringTurn = async () => globalThis.__nativeTest.turn;
      export const runEngineeringTool = async (name, input, sessionId) => {
        globalThis.__nativeTest.executions.push({ name, input, sessionId });
        return { ok: true, output: 'native handler result' };
      };
    `
        }))
      }
    }
  ]
})
const result = spawnSync((await import('electron')).default, ['test/.out/engineering-agent.cjs'], {
  stdio: 'inherit'
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
