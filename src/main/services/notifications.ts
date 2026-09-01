/**
 * Turn-completion notifications — the main-process half.
 *
 * Two jobs, both of which have to live here rather than in the renderer:
 *
 *  - The native OS toast. The renderer's Web `Notification` also reaches the OS,
 *    but it gives no way to focus the window when the toast is clicked, which is
 *    the entire point of the notification.
 *  - Custom sound files. The chosen file is COPIED into `<userData>/sounds/`
 *    and thereafter read back by name, so moving or deleting the original can't
 *    silently break the sound, and the renderer never touches an arbitrary path.
 *
 * The sound itself is PLAYED in the renderer (Electron's main process has no
 * audio output at all), so this file only ever hands over bytes.
 *
 * Deliberately says nothing about WHEN to notify: the `notifyCondition` /
 * `notifySound` decision is the renderer's, because only it knows whether the
 * turn was stopped, whether a queue is still draining, and what the strings say.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Notification } from 'electron'
import {
  NOTIFY_SOUND_EXTENSIONS,
  NOTIFY_SOUND_MAX_BYTES,
  type NotifySoundFile
} from '../../shared/types'

/** Where custom notification sounds are kept. */
function soundsDir(): string {
  return path.join(app.getPath('userData'), 'sounds')
}

/**
 * Resolve a stored sound NAME to a path inside the sounds directory, or null if
 * it escapes it.
 *
 * The name comes back out of the settings table, which a determined user can
 * edit by hand — `../../../etc/passwd` must not become a readable file. Compare
 * the resolved path rather than scanning for `..`, so encodings and symlinked
 * separators can't sneak past a substring check.
 */
function resolveSoundPath(name: string): string | null {
  const dir = soundsDir()
  const full = path.resolve(dir, name)
  if (path.dirname(full) !== path.resolve(dir)) return null
  return full
}

/**
 * Copy a user-chosen audio file into the sounds directory and return its new
 * name, or an error the UI can show.
 *
 * Only ONE custom sound exists at a time: the copy always lands on
 * `custom.<ext>` and older ones are removed, so picking a new sound can't leave
 * a directory of abandoned files behind. The extension is kept because that is
 * what tells the renderer's `<audio>` how to decode the blob.
 */
export async function importSound(
  sourcePath: string
): Promise<{ ok: true; name: string } | { ok: false; error: 'type' | 'size' | 'read' }> {
  const ext = path.extname(sourcePath).slice(1).toLowerCase()
  if (!(NOTIFY_SOUND_EXTENSIONS as readonly string[]).includes(ext))
    return { ok: false, error: 'type' }

  try {
    const stat = await fs.stat(sourcePath)
    if (stat.size > NOTIFY_SOUND_MAX_BYTES) return { ok: false, error: 'size' }

    const dir = soundsDir()
    await fs.mkdir(dir, { recursive: true })
    await clearSounds()
    const name = `custom.${ext}`
    await fs.copyFile(sourcePath, path.join(dir, name))
    return { ok: true, name }
  } catch {
    return { ok: false, error: 'read' }
  }
}

/** Delete every stored custom sound. A missing directory is already the goal. */
export async function clearSounds(): Promise<void> {
  const dir = soundsDir()
  try {
    const entries = await fs.readdir(dir)
    await Promise.all(entries.map((e) => fs.rm(path.join(dir, e), { force: true })))
  } catch {
    // Nothing to clear.
  }
}

/**
 * Read a stored sound back for playback. Null when it is missing — the caller
 * falls back to the bundled default rather than going silent, since a sound the
 * user can't hear is indistinguishable from a broken feature.
 */
export async function readSound(name: string): Promise<NotifySoundFile | null> {
  const full = resolveSoundPath(name)
  if (!full) return null
  try {
    const buf = await fs.readFile(full)
    // Copy out of the pooled Buffer: `buf.buffer` is a shared arena, and sending
    // it whole would ship unrelated memory across IPC.
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    return { name, data }
  } catch {
    return null
  }
}

/**
 * Post a native OS toast. Clicking it brings the window to the front, which is
 * the only reason this isn't the renderer's Web Notification API.
 *
 * `silent: true` always: Roxy plays its own sound, and letting the OS add its
 * default alert on top produces two noises for one event — the exact thing the
 * custom-sound setting exists to avoid.
 */
export function showTurnToast(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, silent: true })
  notification.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  notification.show()
}
