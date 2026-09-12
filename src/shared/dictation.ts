/** Shared, isomorphic contract for Roxy's local speech-to-text runtime. */

export type DictationMode = 'fast' | 'accurate'

export type DictationStatus =
  | 'idle'
  | 'downloading-runtime'
  | 'downloading-model'
  | 'starting'
  | 'ready'
  | 'listening'
  | 'stopping'
  | 'unsupported'
  | 'error'

export interface DictationState {
  status: DictationStatus
  progress: number
  installed: boolean
  mode: DictationMode
  error?: string
  rev: number
}

export interface DictationStartInput {
  requestId: string
  mode: DictationMode
}

export interface DictationTranscript {
  requestId: string
  kind: 'partial' | 'final'
  text: string
}

export interface DictationPolishInput {
  text: string
  providerId: string
  model: string
  chatId?: string | null
}

export interface DictationRuntimeAsset {
  archive: string
  sha256: string
}

export const DICTATION_RUNTIME_VERSION = '0.1.0'
export const DICTATION_MODEL_REVISION = 'ebe59e5a817142986528bbbee5dba8db7b38ed50'
export const DICTATION_MODEL_FILE = 'nemotron-speech-streaming-en-0.6b.q8_0.gguf'
export const DICTATION_MODEL_SHA256 =
  'd9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d'
export const DICTATION_MODEL_SIZE = 699_872_960

const RUNTIME_ASSETS: Record<string, DictationRuntimeAsset> = {
  'win32-x64': {
    archive: 'nemo-speech-0.1.0-windows-x86_64-cpu.zip',
    sha256: '5e4ea81046012edcd77fd8848de8eefb5a4ba38cc26f52eb544ab184695a75d6'
  },
  'darwin-arm64': {
    archive: 'nemo-speech-0.1.0-macos-aarch64-metal.tar.gz',
    sha256: 'f1dff4f9dd9c96214f8cb78b982812459132df8a4ad1a42409fd94de4a366244'
  },
  'darwin-x64': {
    archive: 'nemo-speech-0.1.0-macos-x86_64-cpu.tar.gz',
    sha256: '042a4612e07460fab6a39b5d862aa1e39d0ac3eaedfdb979f3f5fc12de510c20'
  },
  'linux-x64': {
    archive: 'nemo-speech-0.1.0-linux-x86_64-cpu.tar.gz',
    sha256: '0f74131d631ad2c694cf0ec53490866bb6461147959589a69fb6fc231944065b'
  },
  'linux-arm64': {
    archive: 'nemo-speech-0.1.0-linux-aarch64-cpu.tar.gz',
    sha256: '0e4112255d566de7bdd142f239e984995c4447103ba8feb41f2bb5c559d561d3'
  }
}

export function dictationRuntimeAsset(
  platform: NodeJS.Platform,
  arch: string
): DictationRuntimeAsset | undefined {
  return RUNTIME_ASSETS[`${platform}-${arch}`]
}

export function dictationRuntimeUrl(asset: string): string {
  return `https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${DICTATION_RUNTIME_VERSION}/${asset}`
}

export function dictationModelUrl(): string {
  return (
    `https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/` +
    `${DICTATION_MODEL_REVISION}/${DICTATION_MODEL_FILE}`
  )
}

export const IDLE_DICTATION_STATE: DictationState = {
  status: 'idle',
  progress: 0,
  installed: false,
  mode: 'fast',
  rev: 0
}
