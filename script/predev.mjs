/**
 * Kill stale Electron instances from THIS project before `npm run dev`.
 * On Windows, electron-vite's child Electron can survive a terminal close and
 * keep showing an old build (and lock the cache/port). This clears only this
 * project's electron.exe (matched by executable path), and no-ops elsewhere.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

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

// On macOS, copy the app icon into the development Electron.app bundle so native
// notifications and system dialogs in `npm run dev` show Roxy rather than the
// default Electron atom icon. Packaged builds get this from electron-builder.
if (process.platform === 'darwin') {
  try {
    const src = resolve('build/icon.icns')
    const dest = resolve('node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns')
    if (existsSync(src) && existsSync(dest)) {
      copyFileSync(src, dest)
    }
  } catch {
    // best effort — never block dev startup
  }
}
