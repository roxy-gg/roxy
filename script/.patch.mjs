/**
 * CRLF-safe single-replacement patcher: node script/.patch.mjs <file> <patch.json>
 * patch.json = [{ "find": "...", "replace": "..." }, ...] (LF in the JSON).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [file, patchFile] = process.argv.slice(2)
const raw = readFileSync(file, 'utf8')
const crlf = raw.includes('\r\n')
let src = raw.replace(/\r\n/g, '\n')
const patches = JSON.parse(readFileSync(patchFile, 'utf8'))

for (const { find, replace } of patches) {
  const first = src.indexOf(find)
  if (first === -1) {
    console.error(`NOT FOUND in ${file}:\n${find.slice(0, 200)}`)
    process.exit(1)
  }
  if (src.indexOf(find, first + 1) !== -1) {
    console.error(`NOT UNIQUE in ${file}:\n${find.slice(0, 200)}`)
    process.exit(1)
  }
  src = src.slice(0, first) + replace + src.slice(first + find.length)
}

writeFileSync(file, crlf ? src.replace(/\n/g, '\r\n') : src)
console.log(`patched ${file} (${patches.length})`)
