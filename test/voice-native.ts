import { app, utilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { VOICE_MODELS } from '../src/shared/voice'

// Explicit opt-in integration probe: downloads a pinned model into test/.out,
// verifies each file, then feeds a public prerecorded sample. Never opens a mic.
async function run(): Promise<void> {
  const model = VOICE_MODELS.find((entry) =>
    process.argv.includes('--nemotron')
      ? entry.description === 'nemotron'
      : entry.description === 'parakeet'
  )!
  const directory = resolve('test/.out/voice-native-' + model.id)
  await mkdir(directory, { recursive: true })
  for (const file of model.files) {
    const path = join(directory, file.name)
    let valid = false
    try {
      valid =
        (await stat(path)).size === file.bytes &&
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') === file.sha256
    } catch {
      /* first run */
    }
    if (valid) continue
    console.log('Downloading native probe asset:', file.name)
    const response = await fetch(
      `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.name}`,
      { signal: AbortSignal.timeout(600_000) }
    )
    assert(response.ok && response.body)
    const hash = createHash('sha256')
    let size = 0
    const handle = await open(path, 'w')
    try {
      for await (const chunk of response.body!) {
        hash.update(chunk)
        size += chunk.length
        let offset = 0
        while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten
      }
    } finally {
      await handle.close()
    }
    assert.equal(size, file.bytes)
    assert.equal(hash.digest('hex'), file.sha256)
  }
  // Public LibriSpeech fixture, not user audio.
  const sample = await fetch(
    `https://huggingface.co/${model.repository}/resolve/${model.revision}/test_wavs/${model.multilingual ? 'es' : '0'}.wav`
  )
  assert(sample.ok, 'Public recorded speech fixture is available')
  const wave = Buffer.from(await sample.arrayBuffer())
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF')
  let audio = new Float32Array()
  let sampleRate = 16000
  for (let offset = 12; offset + 8 <= wave.length; ) {
    const size = wave.readUInt32LE(offset + 4)
    const tag = wave.toString('ascii', offset, offset + 4)
    if (tag === 'fmt ') {
      assert.equal(wave.readUInt16LE(offset + 8), 1)
      assert.equal(wave.readUInt16LE(offset + 10), 1)
      sampleRate = wave.readUInt32LE(offset + 12)
      assert.equal(wave.readUInt16LE(offset + 22), 16)
    }
    if (tag === 'data') {
      audio = new Float32Array(size / 2)
      for (let i = 0; i < audio.length; i++) audio[i] = wave.readInt16LE(offset + 8 + i * 2) / 32768
    }
    offset += 8 + size + (size % 2)
  }
  assert(audio.length)
  if (sampleRate !== 16000) {
    const resampled = new Float32Array(Math.floor((audio.length * 16000) / sampleRate))
    for (let i = 0; i < resampled.length; i++) {
      const source = (i * sampleRate) / 16000
      const left = Math.floor(source)
      const fraction = source - left
      resampled[i] =
        audio[left] * (1 - fraction) + audio[Math.min(left + 1, audio.length - 1)] * fraction
    }
    audio = resampled
  }
  // Load both packages under Electron's Node 20, without capturing microphone audio.
  const native = await import('@handy-computer/recorder')
  assert.equal(typeof native.Recorder.open, 'function')
  console.log('Native capture binding loaded under Electron', process.versions.electron)
  const child = utilityProcess.fork(resolve('out/main/voice-inference.js'), [], { stdio: 'pipe' })
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  let partial = ''
  let final = ''
  let pending: (() => void) | null = null
  let finishing = false
  let firstTranscript = ''
  try {
    await new Promise<void>((resolveReady, reject) => {
      child.once('exit', (code) => reject(Error('Recognizer exited: ' + code)))
      child.on('message', (message) => {
        if (message.type === 'ready') resolveReady()
        else if (message.type === 'text') {
          final = message.text
          if (!finishing) partial = message.text
        } else if (
          message.type === 'ack' ||
          message.type === 'finished' ||
          message.type === 'started'
        )
          pending?.()
        else if (message.type === 'error') reject(Error('Native recognizer error'))
      })
      child.postMessage({ type: 'load', directory })
    })
    for (const recordingId of ['first', 'second']) {
      partial = ''
      final = ''
      finishing = false
      await new Promise<void>((done) => {
        pending = done
        child.postMessage({ type: 'begin', recordingId })
      })
      for (let offset = 0; offset < audio.length; offset += 1600) {
        await new Promise<void>((done) => {
          pending = done
          child.postMessage({
            type: 'audio',
            recordingId,
            samples: audio.slice(offset, offset + 1600)
          })
        })
      }
      assert(partial.trim(), 'Speech produces a hypothesis before finishing')
      finishing = true
      await new Promise<void>((done) => {
        pending = done
        child.postMessage({ type: 'finish', recordingId })
      })
      assert(final.trim())
      if (firstTranscript)
        assert.equal(final, firstTranscript, 'Fresh stream does not retain previous utterance')
      else firstTranscript = final
      child.postMessage({ type: 'reset', recordingId })
      console.log('Public fixture transcript (' + recordingId + '):', final)
    }
    console.log(
      'VOICE NATIVE OK: verified download, Electron addon loading, warm model reuse, two fresh streams, partial before stop, final flush'
    )
  } finally {
    child.kill()
  }
}
const deadline = setTimeout(() => {
  console.error('Native probe deadline exceeded')
  app.exit(1)
}, 12 * 60_000)
app
  .whenReady()
  .then(run)
  .then(() => {
    clearTimeout(deadline)
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
