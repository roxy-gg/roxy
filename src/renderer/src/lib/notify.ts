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
import { NOTIFY_VOLUME, type AppSettings } from '@shared/types'
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
 * The SESSION NAME is the toast's title: with several sessions running, which
 * one finished is the only thing you actually need from the toast, and the
 * Windows header above it already says Roxy. `sessionTitle` is user data and
 * goes in untranslated; the rest is resolved here because main has no i18next.
 */
export function notifyTurnComplete(
  settings: AppSettings,
  sessionTitle: string,
  chatId: string
): void {
  if (!shouldNotify(settings)) return
  void playNotificationSound()
  // A session can genuinely have no title yet (notify fires on the first turn,
  // which is what names it), and an empty toast heading looks broken.
  const name = sessionTitle.trim() || i18n.t('notifications.turnCompleteUntitled')
  void api.notifications.toast(name, i18n.t('notifications.turnCompleteBody'), chatId)
}
