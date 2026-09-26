/**
 * Turn-completion notifications - the renderer's half.
 *
 * The sound is played here because the main process has no audio output at all.
 * The OS toast is the other way round (see `main/services/notifications.ts`),
 * since only main can focus the window when the toast is clicked.
 *
 * The decision of WHETHER to notify also lives on this side: only the renderer
 * knows whether the user stopped the turn, whether a queue is still draining,
 * and whether the window is focused.
 */
import chime from '../assets/chime.wav'
import { NOTIFY_VOLUME, type AppSettings, type Chat } from '@shared/types'
import i18n from '../i18n'
import { api } from './api'

/**
 * One reused element rather than a fresh `Audio` per turn, so rapid completions
 * restart the chime instead of stacking copies of it on top of each other.
 */
let element: HTMLAudioElement | null = null

/**
 * Play the notification chime.
 *
 * Never throws: autoplay may still be locked because the user has not
 * interacted with the page yet, and that must not take the turn's cleanup down
 * with it.
 */
export async function playNotificationSound(): Promise<void> {
  try {
    element ??= new Audio(chime)
    element.volume = NOTIFY_VOLUME
    element.currentTime = 0
    await element.play()
  } catch {
    // A silent notification is the acceptable failure here.
  }
}

/**
 * Whether a finished turn may notify right now.
 *
 * Being focused suppresses it unconditionally: you are already looking at the
 * answer, so a chime is pure noise. `hasFocus()` rather than `document.hidden`,
 * because a window sitting visible behind the editor is still one you are not
 * watching.
 */
function shouldNotify(settings: AppSettings): boolean {
  return settings.notifyOnComplete && !document.hasFocus()
}

/**
 * Announce that a session's turn finished: chime plus an OS toast. A no-op when
 * notifications are off, or when you are already watching.
 *
 * Use the completed chat, never the currently selected one: another project's
 * turn can finish while the user has switched sessions.
 */
export function notifyTurnComplete(
  settings: AppSettings,
  chat: Pick<Chat, 'id' | 'title' | 'workspacePath'>
): void {
  if (!shouldNotify(settings)) return
  void showCompletionNotification(chat)
}

/** Also used by the Settings preview, which deliberately bypasses focus suppression. */
export async function showCompletionNotification(
  chat?: Pick<Chat, 'id' | 'title' | 'workspacePath'>
): Promise<void> {
  void playNotificationSound()
  // workspacePath is the project root; worktreePath would show an internal slug.
  const project = chat?.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  const session = chat?.title.trim() ?? ''
  const body =
    project && session
      ? i18n.t('notifications.responseReadyForSession', { session })
      : i18n.t('notifications.responseReady')
  try {
    await api.notifications.toast('Roxy', project || session, body, chat?.id ?? '')
  } catch (error) {
    console.warn('Failed to request completion notification:', error)
  }
}
