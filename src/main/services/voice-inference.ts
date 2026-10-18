import { join } from 'node:path'

// Keep model weights warm; each recording owns a fresh stream and transcript.
interface Stream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
  inputFinished(): void
}
interface Recognizer {
  createStream(): Stream
  isReady(stream: Stream): boolean
  decode(stream: Stream): void
  getResult(stream: Stream): { text: string }
  isEndpoint(stream: Stream): boolean
  reset(stream: Stream): void
}
const parent = process.parentPort!
let recognizer: Recognizer
let stream: Stream | null = null
let recordingId: string | null = null
let committed = ''
let previous = ''
function decode(): void {
  if (!stream) return
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  const text = recognizer.getResult(stream).text.trim()
  const full = [committed, text].filter(Boolean).join(' ')
  if (full !== previous) {
    previous = full
    parent.postMessage({ type: 'text', recordingId, text: full })
  }
  if (recognizer.isEndpoint(stream)) {
    committed = full
    recognizer.reset(stream)
  }
}
parent.on('message', ({ data }) => {
  try {
    if (data.type === 'load') {
      const sherpa = require('sherpa-onnx-node') as {
        OnlineRecognizer: new (config: unknown) => Recognizer
      }
      recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 128 },
        modelConfig: {
          transducer: {
            encoder: join(data.directory, 'encoder.int8.onnx'),
            decoder: join(data.directory, 'decoder.int8.onnx'),
            joiner: join(data.directory, 'joiner.int8.onnx')
          },
          tokens: join(data.directory, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20
      })
      parent.postMessage({ type: 'ready' })
    } else if (data.type === 'begin') {
      stream = recognizer.createStream()
      recordingId = data.recordingId
      committed = ''
      previous = ''
      parent.postMessage({ type: 'started', recordingId })
    } else if (data.recordingId !== recordingId) {
      return
    } else if (data.type === 'reset') {
      stream = null
      recordingId = null
      committed = ''
      previous = ''
    } else if (data.type === 'audio' && stream) {
      stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(data.samples) })
      decode()
      parent.postMessage({ type: 'ack', recordingId, frames: data.samples.length })
    } else if (data.type === 'finish' && stream) {
      stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(6400) })
      stream.inputFinished()
      decode()
      parent.postMessage({ type: 'finished', recordingId })
    }
  } catch {
    parent.postMessage({ type: 'error' })
  }
})
