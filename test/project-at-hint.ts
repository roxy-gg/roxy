import assert from 'node:assert/strict'
import {
  PROJECT_AT_HINT_KEY,
  dismissProjectAtHint,
  isProjectAtHintDismissed
} from '../src/renderer/src/lib/project-at-hint'

class MemoryStorage {
  private data = new Map<string, string>()
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

const store = new MemoryStorage()
assert.equal(isProjectAtHintDismissed(store), false)
dismissProjectAtHint(store)
assert.equal(store.getItem(PROJECT_AT_HINT_KEY), '1')
assert.equal(isProjectAtHintDismissed(store), true)

// Storage that throws still must not throw to callers.
const broken: { getItem: () => string; setItem: () => void } = {
  getItem() {
    throw new Error('denied')
  },
  setItem() {
    throw new Error('denied')
  }
}
assert.equal(isProjectAtHintDismissed(broken as never), false)
assert.doesNotThrow(() => dismissProjectAtHint(broken as never))

console.log('project-at-hint: ok')
