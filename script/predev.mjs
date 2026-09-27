/**
 * Kill stale Electron instances from THIS project before `npm run dev`.
 * On Windows, electron-vite's child Electron can survive a terminal close and
 * keep showing an old build (and lock the cache/port). This clears only this
 * project's electron.exe (matched by executable path), and no-ops elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

if (process.platform === 'win32') {
  const dir = process.cwd().replace(/'/g, "''")
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -like '${dir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore'
    })
  } catch {
    // best effort — never block dev startup
  }
}

// npm builds native modules for the host Node.js ABI. Electron embeds its own
// Node.js ABI, so repair native dependencies when another npm command replaced
// the Electron-compatible binary.
try {
  execFileSync(
    require('electron'),
    ['-e', "const Database = require('better-sqlite3'); new Database(':memory:').close()"],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore'
    }
  )
} catch {
  console.log('Native dependencies do not match Electron; rebuilding...')
  await import('./rebuild-native.mjs')
}
