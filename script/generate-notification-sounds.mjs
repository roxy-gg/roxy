/** Original, deterministic notification tones. No recordings or third-party samples. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('../resources/notification-sounds/', import.meta.url))
const rate = 24000
const sine = (phase) => Math.sin(2 * Math.PI * phase)
const note = (frequency, start = 0, duration = 0.6, gain = 1, color = 'bell', end = frequency) => ({
  frequency,
  start,
  duration,
  gain,
  color,
  end
})
const tones = {
  bell: [note(880, 0, 1.1)],
  bloom: [
    note(523.25, 0, 0.9, 0.7, 'soft'),
    note(659.25, 0.12, 1, 0.6, 'soft'),
    note(783.99, 0.24, 1.1, 0.5, 'soft')
  ],
  bubble: [note(600, 0, 0.22, 1, 'sweep', 1050), note(800, 0.17, 0.3, 0.8, 'sweep', 1400)],
  celesta: [
    note(1046.5, 0, 0.65, 0.8),
    note(1318.51, 0.14, 0.75, 0.65),
    note(1567.98, 0.28, 0.85, 0.5)
  ],
  chirp: [note(1300, 0, 0.16, 0.8, 'sweep', 2200), note(1600, 0.21, 0.19, 0.65, 'sweep', 2600)],
  crystal: [note(1174.66, 0, 1.3, 1, 'glass')],
  droplet: [note(1800, 0, 0.38, 1, 'sweep', 430)],
  glimmer: [note(659.25, 0, 0.8, 0.85, 'glass'), note(987.77, 0.2, 1, 0.65, 'glass')],
  marimba: [
    note(523.25, 0, 0.3, 1, 'wood'),
    note(659.25, 0.15, 0.3, 0.85, 'wood'),
    note(783.99, 0.3, 0.45, 0.75, 'wood')
  ],
  orbit: [note(392, 0, 1.3, 1, 'space', 523.25)],
  pluck: [note(587.33, 0, 0.45, 1, 'pluck'), note(880, 0.17, 0.55, 0.75, 'pluck')],
  ripple: [
    note(783.99, 0, 0.55, 1, 'soft'),
    note(783.99, 0.2, 0.55, 0.55, 'soft'),
    note(783.99, 0.4, 0.6, 0.3, 'soft')
  ],
  signal: [note(880, 0, 0.14, 0.9, 'soft'), note(1174.66, 0.2, 0.22, 0.8, 'soft')],
  'soft-ping': [note(698.46, 0, 0.85, 1, 'soft')],
  sparkle: [
    note(1567.98, 0, 0.5, 0.85, 'glass'),
    note(2093, 0.1, 0.6, 0.65, 'glass'),
    note(2637.02, 0.2, 0.75, 0.45, 'glass')
  ],
  woodblock: [note(740, 0, 0.18, 1, 'wood'), note(554.37, 0.22, 0.22, 0.85, 'wood')]
}

mkdirSync(directory, { recursive: true })
for (const [id, notes] of Object.entries(tones)) {
  const duration = Math.max(...notes.map((n) => n.start + n.duration)) + 0.04
  const samples = new Float64Array(Math.ceil(duration * rate))
  for (const n of notes) {
    for (let i = 0; i < Math.ceil(n.duration * rate); i++) {
      const t = i / rate
      const progress = t / n.duration
      const phase = n.frequency * t + ((n.end - n.frequency) * t * t) / (2 * n.duration)
      let wave = sine(phase)
      if (n.color === 'bell')
        wave +=
          0.3 * sine(phase * 2.76) * Math.exp(-5 * progress) +
          0.12 * sine(phase * 5.4) * Math.exp(-9 * progress)
      if (n.color === 'glass')
        wave += 0.22 * sine(phase * 2.01) + 0.13 * sine(phase * 3.98) * Math.exp(-4 * progress)
      if (n.color === 'wood')
        wave +=
          0.5 * sine(phase * 3.9) * Math.exp(-12 * progress) +
          0.25 * sine(phase * 7.2) * Math.exp(-18 * progress)
      if (n.color === 'pluck')
        wave +=
          0.35 * sine(phase * 2) * Math.exp(-4 * progress) +
          0.18 * sine(phase * 3) * Math.exp(-7 * progress)
      if (n.color === 'space') wave = sine(phase + 0.4 * sine(t * 2)) + 0.25 * sine(phase * 1.5)
      const attack = n.color === 'space' ? 0.08 : n.color === 'soft' ? 0.018 : 0.004
      const decay = n.color === 'wood' ? 9 : n.color === 'space' ? 3 : 5
      // Smooth attacks and tails prevent clicks even on the percussive tones.
      const envelope =
        Math.min(1, t / attack) *
        Math.exp(-decay * progress) *
        Math.min(1, (n.duration - t) / 0.035)
      samples[Math.round(n.start * rate) + i] += wave * envelope * n.gain
    }
  }
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
  const gain = Math.min(0.65 / peak, 0.13 / rms)
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++)
    wav.writeInt16LE(Math.round(samples[i] * gain * 32767), 44 + i * 2)
  writeFileSync(`${directory}/${id}.wav`, wav)
}
console.log(`Generated ${Object.keys(tones).length} original notification sounds`)
