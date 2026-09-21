import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import * as repo from '../src/main/db/repo'
import { closeDb, getDb } from '../src/main/db/database'
import { repairSchema } from '../src/main/db/migrations'

/** Real SQLite/secret storage, without touching any user's accounts or network. */
export function testProviderPersistence(): void {
  const migration = new Database(':memory:')
  migration.exec(`CREATE TABLE providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, wire TEXT NOT NULL, auth TEXT NOT NULL,
    base_url TEXT, default_model TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  ); INSERT INTO providers VALUES ('openai', 'OpenAI', 'openai-chat', 'api-key', NULL, NULL, 1, 0, 1)`)
  repairSchema(migration)
  const migrated = migration.prepare('SELECT * FROM providers').get() as Record<string, unknown>
  assert.equal(migrated.id, 'openai')
  assert.equal(migrated.seed_id, 'openai')
  assert.equal(migrated.account_number, 1)
  assert.equal(migrated.name, 'OpenAI 1')
  migration.prepare("UPDATE providers SET name = 'Personal'").run()
  repairSchema(migration)
  assert.equal(
    (migration.prepare('SELECT name FROM providers').get() as { name: string }).name,
    'Personal'
  )
  migration.close()

  const ids: string[] = []
  let chatId: string | undefined
  try {
    const a = repo.connectProvider({ id: 'openai', apiKey: 'key-a' })
    const b = repo.connectProvider({ id: 'openai', apiKey: 'key-b' })
    ids.push(a.id, b.id)
    assert.notEqual(a.id, b.id)
    assert.notEqual(a.id, a.seedId)
    assert.equal(b.accountNumber, a.accountNumber + 1)
    assert.equal(repo.getProviderToken(a.id), 'key-a')
    assert.equal(repo.getProviderToken(b.id), 'key-b')
    repo.renameProvider(a.id, ' Personal ')
    const chat = repo.createChat({
      title: 'account persistence',
      providerId: a.id,
      model: 'model-a'
    })
    chatId = chat.id
    repo.recordRecentModel(a.id, 'model-a')
    repo.setModelHidden(a.id, 'hidden-a', true)
    assert.equal(
      repo.connectProvider({ id: 'openai', connectionId: a.id, apiKey: 'rotated' }).name,
      'Personal'
    )
    assert.throws(() =>
      repo.connectProvider({ id: 'anthropic', connectionId: a.id, apiKey: 'wrong' })
    )
    assert.throws(() => repo.renameProvider(a.id, '  '))
    assert.throws(() => repo.renameProvider(a.id, 'x'.repeat(101)))
    closeDb()
    assert.equal(repo.getProviderToken(a.id), 'rotated')
    assert.equal(repo.getChat(chat.id)?.providerId, a.id)
    assert.equal(repo.listRecentModels(a.id)[0]?.model, 'model-a')
    assert.ok(repo.listHiddenModels().some((m) => m.providerId === a.id && m.model === 'hidden-a'))
    repo.disconnectProvider(b.id)
    const c = repo.connectProvider({ id: 'openai', apiKey: 'key-c' })
    ids.push(c.id)
    assert.equal(c.accountNumber, b.accountNumber + 1, 'deleted numbers are never reused')

    const copilot = repo.storeCopilotCredential({ accessToken: 'gh-a' }, undefined, 'test-login')
    ids.push(copilot.id)
    repo.renameProvider(copilot.id, 'Work GitHub')
    const session = repo.getCopilotSessionKey(copilot.id)
    assert.throws(() =>
      repo.storeCopilotCredential({ accessToken: 'duplicate' }, undefined, 'TEST-LOGIN')
    )
    assert.throws(() =>
      repo.storeCopilotCredential({ accessToken: 'wrong-account' }, copilot.id, 'other-login')
    )
    const reconnected = repo.storeCopilotCredential(
      { accessToken: 'gh-new' },
      copilot.id,
      'test-login'
    )
    assert.equal(reconnected.name, 'Work GitHub')
    assert.equal(reconnected.accountNumber, copilot.accountNumber)
    assert.notEqual(repo.getCopilotSessionKey(copilot.id), session)
    assert.throws(() => repo.storeCopilotCredential({ accessToken: 'wrong' }, a.id))

    // A migrated subscription row keeps its id, label and all existing pins.
    getDb()
      .prepare(
        `INSERT INTO providers
      (id, seed_id, account_number, name, wire, auth, enabled, sort_order, created_at)
      VALUES ('codex-subscription', 'codex-subscription', 1, 'Legacy work', 'openai-responses', 'subscription', 1, 0, 0)`
      )
      .run()
    ids.push('codex-subscription')
    repairSchema(getDb())
    const first = repo.storeCliProxyProvider(
      'codex-subscription',
      'http://127.0.0.1:1234',
      'local',
      {
        file: 'account-a.json',
        prefix: 'a',
        email: 'a@example.test',
        connectionId: 'codex-subscription'
      }
    )
    assert.equal(first.id, 'codex-subscription')
    assert.equal(first.name, 'Legacy work')
    const again = repo.storeCliProxyProvider(
      'codex-subscription',
      'http://127.0.0.1:5678',
      'new-local',
      {
        proxyAuthFile: 'account-a.json',
        proxyPrefix: 'a',
        identity: 'a@example.test'
      }
    )
    assert.equal(again.id, first.id)
    assert.equal(again.name, first.name)
    assert.equal(repo.getProviderToken(first.id), 'new-local')
    const second = repo.storeCliProxyProvider(
      'codex-subscription',
      'http://127.0.0.1:5678',
      'local',
      {
        file: 'account-b.json',
        prefix: 'b',
        email: 'b@example.test'
      }
    )
    ids.push(second.id)
    assert.notEqual(second.id, first.id)
    assert.equal(second.accountNumber, 2)
    assert.throws(() =>
      repo.storeCliProxyProvider('codex-subscription', 'http://127.0.0.1:5678', 'local', {
        file: 'account-a.json',
        prefix: 'a',
        connectionId: second.id
      })
    )
    repo.disconnectProvider(first.id)
    assert.equal(
      repo.listConnectedProviders().find((p) => p.id === second.id)?.proxyAuthFile,
      'account-b.json'
    )
    console.log(
      '  ✓ provider persistence: migration, numbering, secrets, rename, reconnect and subscription binding'
    )
  } finally {
    if (chatId) repo.removeChat(chatId)
    for (const id of ids) {
      repo.setProviderHiddenModels(id, [])
      getDb().prepare('DELETE FROM recent_models WHERE provider_id = ?').run(id)
      repo.disconnectProvider(id)
    }
  }
}
