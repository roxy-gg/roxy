const TARGET_RATE = 16_000

const WORKLET_SOURCE = `
class RoxyDictationCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(4096)
    this.offset = 0
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return
      if (this.offset > 0) {
        const chunk = this.buffer.slice(0, this.offset)
        this.port.postMessage(chunk, [chunk.buffer])
        this.offset = 0
      }
      this.port.postMessage({ type: 'flushed' })
    }
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    let at = 0
    while (at < input.length) {
      const count = Math.min(input.length - at, this.buffer.length - this.offset)
      this.buffer.set(input.subarray(at, at + count), this.offset)
      this.offset += count
      at += count
      if (this.offset === this.buffer.length) {
        const chunk = this.buffer
        this.port.postMessage(chunk, [chunk.buffer])
        this.buffer = new Float32Array(4096)
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('roxy-dictation-capture', RoxyDictationCapture)
`

function pcm16(input: Float32Array, sourceRate: number): ArrayBuffer {
  const ratio = sourceRate / TARGET_RATE
  const length = Math.max(1, Math.floor(input.length / ratio))
  const output = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const before = Math.floor(position)
    const after = Math.min(input.length - 1, before + 1)
    const mix = position - before
    const sample = Math.max(-1, Math.min(1, input[before] * (1 - mix) + input[after] * mix))
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output.buffer
}

export interface DictationCapture {
  stop(): Promise<void>
}

export async function startDictationCapture(
  onAudio: (audio: ArrayBuffer) => void
): Promise<DictationCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  })
  let context: AudioContext | null = null
  try {
    context = new AudioContext({ latencyHint: 'interactive' })
    const moduleUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    )
    try {
      await context.audioWorklet.addModule(moduleUrl)
    } finally {
      URL.revokeObjectURL(moduleUrl)
    }
    const source = context.createMediaStreamSource(stream)
    const capture = new AudioWorkletNode(context, 'roxy-dictation-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1
    })
    let flushResolve: (() => void) | null = null
    capture.port.onmessage = (event: MessageEvent<Float32Array | { type: string }>) => {
      if (!(event.data instanceof Float32Array)) {
        if (event.data.type === 'flushed') flushResolve?.()
        return
      }
      onAudio(pcm16(event.data, context!.sampleRate))
    }
    source.connect(capture)
    await context.resume()

    let stopped = false
    return {
      async stop(): Promise<void> {
        if (stopped) return
        stopped = true
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 500)
          flushResolve = () => {
            window.clearTimeout(timeout)
            resolve()
          }
          capture.port.postMessage('flush')
        })
        flushResolve = null
        capture.port.onmessage = null
        source.disconnect()
        capture.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        await context!.close()
      }
    }
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    if (context && context.state !== 'closed') await context.close().catch(() => undefined)
    throw error
  }
}
