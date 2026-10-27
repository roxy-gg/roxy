import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../script/bundle-cliproxy.cjs', import.meta.url), 'utf8')
const metadataUrl = 'https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest'

function downloader(fetch, env = {}) {
  const waits = []
  const warnings = []
  const signals = []
  const context = vm.createContext({
    require: (name) =>
      name === 'node:timers/promises'
        ? { setTimeout: async (ms) => waits.push(ms) }
        : require(name),
    module: { exports: {} },
    process: { env },
    Buffer,
    URL,
    AbortSignal: {
      timeout(ms) {
        assert.equal(ms, 180_000)
        const signal = {}
        signals.push(signal)
        return signal
      }
    },
    console: { warn: (message) => warnings.push(message) },
    fetch
  })
  vm.runInContext(source, context)
  return { fetchBytes: vm.runInContext('fetchBytes', context), waits, warnings, signals }
}

test('a successful download is returned without retrying', async () => {
  let calls = 0
  const d = downloader(async () => {
    calls++
    return new Response('archive')
  })
  assert.equal((await d.fetchBytes(metadataUrl, 'metadata')).toString(), 'archive')
  assert.equal(calls, 1)
  assert.deepEqual(d.waits, [])
  assert.deepEqual(d.warnings, [])
})

test('403 metadata failures recover on the third attempt with exponential backoff', async () => {
  const failures = []
  let calls = 0
  const d = downloader(async () => {
    if (++calls === 3) return new Response('metadata')
    const response = new Response('forbidden', { status: 403 })
    failures.push(response)
    return response
  })
  assert.equal((await d.fetchBytes(metadataUrl, 'metadata')).toString(), 'metadata')
  assert.equal(calls, 3)
  assert.deepEqual(d.waits, [2000, 4000])
  assert.equal(d.warnings.length, 2)
  assert.match(d.warnings[1], /attempt 2\/5.*403.*retrying in 4s/)
  assert.ok(
    failures.every((response) => response.bodyUsed),
    'discard failed response bodies'
  )
  assert.equal(new Set(d.signals).size, 3, 'each attempt gets a fresh timeout')
})

test('transient HTTP failures stop after five attempts', async () => {
  for (const status of [403, 408, 429, 500, 502, 503, 504]) {
    let calls = 0
    const d = downloader(async () => {
      calls++
      return new Response('unavailable', { status })
    })
    await assert.rejects(d.fetchBytes(metadataUrl, 'metadata'), (error) => {
      assert.match(error.message, /metadata after 5 attempts/)
      assert.ok(error.message.includes(`(${status})`))
      assert.ok(error.cause.message.includes(`(${status})`))
      return true
    })
    assert.equal(calls, 5)
    assert.deepEqual(d.waits, [2000, 4000, 8000, 16000])
    assert.equal(d.warnings.length, 4)
  }
})

test('permanent HTTP errors fail immediately', async () => {
  for (const status of [400, 401, 404, 422]) {
    let calls = 0
    const d = downloader(async () => {
      calls++
      return new Response('invalid request', { status })
    })
    await assert.rejects(d.fetchBytes(metadataUrl, 'metadata'), new RegExp(`\\(${status}\\)`))
    assert.equal(calls, 1)
    assert.deepEqual(d.waits, [])
  }
})

test('network, timeout and interrupted-body failures are retried', async () => {
  for (const error of [
    new TypeError('fetch failed'),
    new DOMException('timeout', 'TimeoutError')
  ]) {
    let calls = 0
    const d = downloader(async () => {
      if (++calls === 1) throw error
      if (calls === 2) {
        return {
          ok: true,
          arrayBuffer: async () => {
            throw new TypeError('terminated')
          }
        }
      }
      return new Response('archive')
    })
    assert.equal((await d.fetchBytes(metadataUrl, 'archive')).toString(), 'archive')
    assert.deepEqual(d.waits, [2000, 4000])
  }
})

test('persistent network failures preserve the cause and exhaust the retry budget', async () => {
  const cause = new TypeError('fetch failed')
  let calls = 0
  const d = downloader(async () => {
    calls++
    throw cause
  })
  await assert.rejects(d.fetchBytes(metadataUrl, 'archive'), (error) => {
    assert.match(error.message, /archive after 5 attempts: fetch failed/)
    assert.equal(error.cause, cause)
    return true
  })
  assert.equal(calls, 5)
  assert.deepEqual(d.waits, [2000, 4000, 8000, 16000])
})

test('CI tokens authenticate only the GitHub API, never release asset hosts', async () => {
  for (const env of [
    { GH_TOKEN: 'primary', GITHUB_TOKEN: 'fallback' },
    { GITHUB_TOKEN: 'fallback' },
    {}
  ]) {
    const calls = []
    const d = downloader(async (url, options) => {
      calls.push({ url, ...options })
      return new Response('ok')
    }, env)
    for (const url of [
      metadataUrl,
      'https://github.com/router-for-me/CLIProxyAPI/releases/download/v1.0.0/checksums.txt',
      'https://release-assets.githubusercontent.com/archive',
      'https://api.github.com.example.test/archive',
      'http://api.github.com/archive'
    ]) {
      await d.fetchBytes(url, 'download')
    }
    assert.equal(
      calls[0].headers.Authorization,
      env.GH_TOKEN || env.GITHUB_TOKEN ? `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN}` : undefined
    )
    assert.ok(calls.slice(1).every((call) => call.headers.Authorization === undefined))
    assert.ok(calls.every((call) => call.headers['User-Agent'] === 'roxy-build'))
  }
})
