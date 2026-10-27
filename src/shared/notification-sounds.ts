export const SOUND_MAX_BYTES = 2 * 1024 * 1024
export const SOUND_MAX_COUNT = 20
export const SOUND_MIN_SECONDS = 0.1
export const SOUND_MAX_SECONDS = 5

export const BUILTIN_NOTIFICATION_SOUNDS = [
  'bell',
  'bloom',
  'bubble',
  'celesta',
  'chirp',
  'crystal',
  'droplet',
  'glimmer',
  'marimba',
  'orbit',
  'pluck',
  'ripple',
  'signal',
  'soft-ping',
  'sparkle',
  'woodblock'
] as const

export function isBuiltinNotificationSound(
  id: unknown
): id is `builtin:${(typeof BUILTIN_NOTIFICATION_SOUNDS)[number]}` {
  return (
    typeof id === 'string' && BUILTIN_NOTIFICATION_SOUNDS.some((sound) => id === `builtin:${sound}`)
  )
}

export interface NotificationSound {
  id: string
  name: string
  format: 'mp3' | 'wav'
  bytes: number
  duration: number
}

export interface NotificationSoundLibrary {
  selectedId: string | null
  sounds: NotificationSound[]
}

export type NotificationSoundError =
  | 'cancelled'
  | 'tooLarge'
  | 'invalidAudio'
  | 'duration'
  | 'libraryFull'
  | 'readFailed'
  | 'saveFailed'

export type NotificationSoundResult =
  | { ok: true; state: NotificationSoundLibrary }
  | { ok: false; error: NotificationSoundError }
