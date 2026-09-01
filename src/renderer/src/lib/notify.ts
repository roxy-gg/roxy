/**
 * Turn-completion notifications — the renderer's half.
 *
 * The sound is played here because the main process has no audio output at all;
 * main only stores the custom file and hands back its bytes. The OS toast is the
 * other way round (see `main/services/notifications.ts`), since only main can
 * focus the window when the toast is clicked.
 *
 * The decision of WHETHER to notify also lives on this side: only the renderer
 * knows whether the user stopped the turn, whether a queue is still draining,
 * and whether the window is focused.
 */
import defaultChime from '../assets/chime.wav'
import type { AppSettings } from '@shared/types'
import i18n from '../i18n'
import { api } from './api'

/**
 * The playable URL for the current sound, and the setting it was built from.
 * Cached because re-reading the custom file from disk on every turn is pointless
 * IO; keying it by name means changing the sound in Settings invalidates it
 * without any explicit cache-busting call.
 */
let cached: { name: string | null; url: string } | null = null
let element: HTMLAudioElement | null = null

async function soundUrl(name: string | null): Promise<string> {
  if (cached && cached.name === name) return cached.url
  if (cached?.url.startsWith('blob:')) URL.revokeObjectURL(cached.url)

  if (!name) {
    cached = { name: null, url: defaultChime }
    return cached.url
  }
  const file = await api.notifications.readSound()
  // The custom file went missing (deleted behind our back, or a copy that
  // failed). Falling back to the default beats going silent: a notification you
  // can't hear is indistinguishable from the feature being broken.
  if (!file) {
    cached = { name, url: defaultChime }
    return cached.url
  }
  const url = URL.createObjectURL(new Blob([file.data]))
  cached = { name, url }
  return url
}

/**
 * Play the configured notification sound. Never throws: an unplayable file (a
 * codec Chromium won't take, or autoplay still locked because the user hasn't
 * interacted with the page yet) must not take the turn's cleanup down with it.
 */
export async function playNotificationSound(settings: AppSettings): Promise<void> {
  try {
    const url = await soundUrl(settings.notifySoundName)
    if (!element || element.src !== url) element = new Audio(url)
    element.volume = settings.notifyVolume
    element.currentTime = 0
    await element.play()
  } catch {
    // A silent notification is the acceptable failure here.
  }
}

/** Whether a finished turn may notify right now, per the user's condition. */
function shouldNotify(settings: AppSettings): boolean {
  if (settings.notifyCondition === 'never') return false
  if (settings.notifyCondition === 'always') return true
  // 'unfocused' — `hasFocus()` rather than `document.hidden`, because a window
  // sitting visible behind the editor is still one you are not watching.
  return !document.hasFocus()
}

/**
 * Announce that a session's turn finished: a sound, an OS toast, or both,
 * according to settings. A no-op when the condition says so.
 *
 * `sessionTitle` is user data and goes in untranslated; the surrounding copy is
 * resolved here because main has no i18next instance.
 */
export function notifyTurnComplete(settings: AppSettings, sessionTitle: string): void {
  if (!shouldNotify(settings)) return
  if (settings.notifySound) void playNotificationSound(settings)
  if (settings.notifySystemToast) {
    void api.notifications.toast(
      i18n.t('notifications.turnCompleteTitle'),
      i18n.t('notifications.turnCompleteBody', { session: sessionTitle })
    )
  }
}
