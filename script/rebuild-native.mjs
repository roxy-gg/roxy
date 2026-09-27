import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const betterSqliteDir = dirname(require.resolve('better-sqlite3/package.json'))

// electron-rebuild can leave an existing host-Node binary in place. Removing
// the generated output first guarantees it installs a binary for Electron.
rmSync(resolve(betterSqliteDir, 'build'), { recursive: true, force: true })
execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), 'install-app-deps'], {
  stdio: 'inherit'
})
