import type { TFunction } from 'i18next'
import type { MessagePart } from '@shared/types'

export type ActivityVerb = 'thinking' | 'analyzing' | 'writing' | 'working'

export const ACTIVITY_PHRASE_ROTATION_MS = 10_000

export const ACTIVITY_SUFFIX_KEYS = [
  'transcript.activitySuffix.cosmicMagic',
  'transcript.activitySuffix.immortalCrabThoughts',
  'transcript.activitySuffix.interdimensionalSnacks',
  'transcript.activitySuffix.moonlitSyntax',
  'transcript.activitySuffix.tinyThunder',
  'transcript.activitySuffix.suspiciousPixels',
  'transcript.activitySuffix.goblinPaperwork',
  'transcript.activitySuffix.forbiddenGeometry',
  'transcript.activitySuffix.quantumBreadcrumbs',
  'transcript.activitySuffix.politeChaos',
  'transcript.activitySuffix.caffeinatedStardust',
  'transcript.activitySuffix.oneMoreDimension'
] as const

const ACTIVITY_VERB_KEYS = {
  thinking: 'transcript.activityVerb.thinking',
  analyzing: 'transcript.activityVerb.analyzing',
  writing: 'transcript.activityVerb.writing',
  working: 'transcript.activityVerb.working'
} as const

export interface ActivityPhraseState {
  identity: string
  suffixIndex: number
  nextRotationAt: number
}

export function activityVerb(parts: MessagePart[]): ActivityVerb {
  const last = parts[parts.length - 1]
  if (!last) return 'thinking'
  if (last.type === 'reasoning') return 'analyzing'
  if (last.type === 'text') return 'writing'
  return 'working'
}

export function activityIdentity(actor: string, parts: MessagePart[]): string {
  return `${actor}:${activityVerb(parts)}`
}

export function updateActivityPhrase(
  previous: ActivityPhraseState | null,
  identity: string,
  now: number,
  random: () => number = Math.random
): ActivityPhraseState {
  if (!previous || previous.identity !== identity) {
    return {
      identity,
      suffixIndex: randomIndex(ACTIVITY_SUFFIX_KEYS.length, random),
      nextRotationAt: now + ACTIVITY_PHRASE_ROTATION_MS
    }
  }
  if (now < previous.nextRotationAt) return previous
  return {
    identity,
    suffixIndex: randomIndex(ACTIVITY_SUFFIX_KEYS.length, random, previous.suffixIndex),
    nextRotationAt: now + ACTIVITY_PHRASE_ROTATION_MS
  }
}

export function activityLabels(t: TFunction, verb: ActivityVerb): string[] {
  const verbLabel = t(ACTIVITY_VERB_KEYS[verb])
  return ACTIVITY_SUFFIX_KEYS.map((key) =>
    t('transcript.activityStatus', { verb: verbLabel, suffix: t(key) })
  )
}

function randomIndex(length: number, random: () => number, previous?: number): number {
  if (length <= 1) return 0
  const choices = previous === undefined ? length : length - 1
  const picked = Math.min(choices - 1, Math.max(0, Math.floor(random() * choices)))
  return previous !== undefined && picked >= previous ? picked + 1 : picked
}
