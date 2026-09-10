export type MotionPreference = 'on' | 'system' | 'reduced'

export const DEFAULT_MOTION: MotionPreference = 'on'

export function normalizeMotion(value: unknown): MotionPreference {
  return value === 'system' || value === 'reduced' ? value : DEFAULT_MOTION
}

export function reduceMotion(value: unknown, systemReduced: boolean): boolean {
  const preference = normalizeMotion(value)
  return preference === 'reduced' || (preference === 'system' && systemReduced)
}
