/** Dismissible project-@ honesty hint (composer). Once per profile via localStorage. */
export const PROJECT_AT_HINT_KEY = 'roxy.composer.projectAtHint.v1'

export type HintStorage = Pick<Storage, 'getItem' | 'setItem'>

export function isProjectAtHintDismissed(
  storage: HintStorage | null | undefined = globalThis.localStorage
): boolean {
  try {
    return storage?.getItem(PROJECT_AT_HINT_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissProjectAtHint(
  storage: HintStorage | null | undefined = globalThis.localStorage
): void {
  try {
    storage?.setItem(PROJECT_AT_HINT_KEY, '1')
  } catch {
    /* private mode / quota — treat as best-effort */
  }
}
