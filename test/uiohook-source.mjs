import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const archive = readFileSync('resources/third-party/uiohook/uiohook-napi-1.5.5-source.tgz')
const tar = gunzipSync(archive, { maxOutputLength: 4 * 1024 * 1024 })
const files = new Set()
let end = 0
while (end + 512 <= tar.length && tar[end] !== 0) {
  const header = tar.subarray(end, end + 512)
  const text = (start, length) =>
    header
      .subarray(start, start + length)
      .toString()
      .split('\0')[0]
  const name = text(0, 100)
  const size = parseInt(text(124, 12).trim(), 8)
  assert(Number.isSafeInteger(size) && size >= 0)
  assert(['0', '\0', '5'].includes(String.fromCharCode(header[156])), `Unexpected entry: ${name}`)
  assert(name.startsWith('package/') && !name.split('/').includes('..'), name)
  assert(!name.startsWith('package/prebuilds/'), `Prebuilt binary in source archive: ${name}`)
  assert(
    !/\.(node|exe|dll|so|dylib|a|o|tgz|gz|zip)$/i.test(name),
    `Binary or nested archive: ${name}`
  )
  assert(end + 512 + size <= tar.length, `Truncated entry: ${name}`)
  assert(!files.has(name), `Duplicate entry: ${name}`)
  files.add(name)
  end += 512 + Math.ceil(size / 512) * 512
}
assert(
  tar.subarray(end).every((byte) => byte === 0),
  'Unexpected data after tar entries'
)
for (const name of [
  'LICENSE',
  'package.json',
  'binding.gyp',
  'src/lib/addon.c',
  'src/lib/uiohook_worker.c',
  'libuiohook/include/uiohook.h',
  ...['darwin', 'windows', 'x11'].flatMap((platform) =>
    ['input_helper.c', 'input_hook.c', 'post_event.c', 'system_properties.c'].map(
      (file) => `libuiohook/src/${platform}/${file}`
    )
  )
])
  assert(files.has(`package/${name}`), `Missing corresponding source: ${name}`)
const digest = createHash('sha256').update(archive).digest('hex')
assert(
  readFileSync('resources/third-party/uiohook/NOTICE.md', 'utf8').includes(
    `SHA-256: \`${digest}\``
  ),
  'NOTICE must identify the bundled source archive digest'
)
console.log(
  `UIOHOOK SOURCE OK: ${files.size} source/build files, no prebuilt binaries, verified digest`
)
