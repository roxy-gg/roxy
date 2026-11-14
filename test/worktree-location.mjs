import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { transformSync } from 'esbuild'

// Exercise the real picker handler without opening native dialogs in CI.
const source = readFileSync(new URL('../src/main/ipc/index.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n'
)
const handler = source.match(
  /ipcMain\.handle\(CHANNELS\.dialogPickWorktreeRoot, (async \(event\) => \{[\s\S]*?\n  \})\)/
)?.[1]
assert.ok(handler, 'worktree picker handler found')
const code = transformSync(`const pick = ${handler}`, { loader: 'ts' }).code

for (const [paths, parent, defaultRoot] of [
  [path.win32, 'G:\\', 'C:\\Users\\Developer\\AppData\\Roaming\\roxy\\worktrees'],
  [path.win32, 'G:\\My Projects', 'C:\\Users\\Developer\\AppData\\Roaming\\roxy\\worktrees'],
  [path.posix, '/mnt/storage', '/home/developer/.config/roxy/worktrees']
]) {
  let current = null
  let result = { canceled: false, filePaths: [parent] }
  let window = {}
  let lastOptions
  const pick = new Function(
    'BrowserWindow',
    'dialog',
    'repo',
    'git',
    'path',
    `${code}\nreturn pick;`
  )(
    { fromWebContents: () => window },
    {
      showOpenDialog: async (...args) => {
        lastOptions = args.at(-1)
        return result
      }
    },
    { getSettings: () => ({ worktreeRoot: current }) },
    { defaultWorktreeRoot: () => defaultRoot },
    paths
  )
  const finalPath = paths.join(parent, 'roxy')
  assert.equal(await pick({ sender: {} }), finalPath, 'use a dedicated roxy subfolder')
  assert.equal(lastOptions.defaultPath, paths.dirname(defaultRoot))
  assert.deepEqual(lastOptions.properties, ['openDirectory', 'createDirectory'])
  current = finalPath
  assert.equal(await pick({ sender: {} }), finalPath)
  assert.equal(
    lastOptions.defaultPath,
    parent,
    'reopening starts at the selected parent, not roxy/roxy'
  )
  window = null
  assert.equal(await pick({ sender: {} }), finalPath, 'works without a parent window')
  result = { canceled: true, filePaths: [parent] }
  assert.equal(await pick({ sender: {} }), null, 'cancel does not change the location')
  result = { canceled: false, filePaths: [] }
  assert.equal(await pick({ sender: {} }), null, 'empty selection does not change the location')
}

console.log('Worktree location picker: drive roots, folder paths, reopen and cancellation passed')
