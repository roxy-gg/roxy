/**
 * Installing the bundled Session Relay extension where a real browser can load
 * it.
 *
 * Chrome cannot load an unpacked extension from inside an asar archive, and on
 * a packaged build our files live under `resources/` (kept unpacked via
 * `asarUnpack` in electron-builder.yml). Rather than point the user at a path
 * buried in the app bundle — which breaks on every update, and which macOS
 * hides — we COPY the extension into the user's Documents folder. That path is
 * stable, greppable, and survives Roxy updating underneath it.
 *
 * The copy is re-run on every install click so an app update refreshes the
 * extension in place; the user just hits Reload in their browser.
 */
import { app, shell } from 'electron'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Folder name under Documents. Recognisable in a "Load unpacked" dialog. */
const FOLDER = 'Roxy Session Relay'

/** Where the extension ships inside the app. */
function sourceDir(): string {
  // Packaged: resources are unpacked next to the asar. Dev: straight from the
  // repo, since `resources/` is not copied into out/.
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'session-relay')
    : join(app.getAppPath(), 'resources', 'session-relay')
}

/** Where the user loads it from. */
export function installDir(): string {
  return join(app.getPath('documents'), FOLDER)
}

export interface InstallResult {
  path: string
  version: string
}

/**
 * Copy the extension to Documents, replacing any previous copy.
 *
 * We delete first rather than copy over the top: a stale file from an older
 * version (a renamed script, a dropped asset) would otherwise linger and could
 * break the load with a confusing manifest error.
 */
export async function install(): Promise<InstallResult> {
  const src = sourceDir()
  if (!existsSync(src)) {
    throw new Error(`The bundled extension is missing from this build (${src}).`)
  }
  const dest = installDir()
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true })

  let version = ''
  try {
    version = JSON.parse(await readFile(join(dest, 'manifest.json'), 'utf8')).version ?? ''
  } catch {
    // Non-fatal: the copy is what matters, the version is only shown in the UI.
  }
  return { path: dest, version }
}

/** Open the folder in the OS file manager, so "Load unpacked" is a short trip. */
export async function reveal(): Promise<void> {
  const dir = installDir()
  if (!existsSync(dir)) throw new Error('Install the extension first.')
  await shell.openPath(dir)
}
