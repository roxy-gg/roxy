// One-off generator for the bundled notification sound.
// Run with `node script/gen-chime.mjs`; writes src/renderer/src/assets/chime.wav.
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 44100
const DURATION = 0.55
const frames = Math.round(RATE * DURATION)

// Two plucked partials a fifth apart, the second struck slightly later: a soft
// "ti-ding" that reads as a completion rather than an alert.
const notes = [
  { freq: 880, start: 0, gain: 0.55 },
  { freq: 1318.51, start: 0.09, gain: 0.45 }
]

const samples = new Float32Array(frames)
for (const note of notes) {
  const offset = Math.round(note.start * RATE)
  for (let i = offset; i < frames; i++) {
    const t = (i - offset) / RATE
    // Exponential decay for the body, short attack ramp so it never clicks.
    const decay = Math.exp(-4.2 * t)
    const attack = Math.min(1, t / 0.004)
    const partial =
      Math.sin(2 * Math.PI * note.freq * t) + 0.22 * Math.sin(2 * Math.PI * note.freq * 2 * t)
    samples[i] += note.gain * attack * decay * partial
  }
}

// Normalize, then fade the tail to zero so the buffer ends in silence.
let peak = 0
for (const s of samples) peak = Math.max(peak, Math.abs(s))
const fadeFrames = Math.round(0.02 * RATE)
const pcm = Buffer.alloc(frames * 2)
for (let i = 0; i < frames; i++) {
  const fade = i > frames - fadeFrames ? (frames - i) / fadeFrames : 1
  const v = Math.max(-1, Math.min(1, (samples[i] / peak) * 0.85 * fade))
  pcm.writeInt16LE(Math.round(v * 32767), i * 2)
}

const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + pcm.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20) // PCM
header.writeUInt16LE(1, 22) // mono
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(pcm.length, 40)

const out = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/assets/chime.wav')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.concat([header, pcm]))
console.log(`wrote ${out} (${header.length + pcm.length} bytes)`)
