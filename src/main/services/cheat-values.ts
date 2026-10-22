import { CHEAT_VALUE_TYPES, type CheatValueType } from '../../shared/cheat'

export function valueSize(type: unknown, pointerSize: number): number {
  if (!CHEAT_VALUE_TYPES.includes(type as CheatValueType)) throw new Error('Unknown value type.')
  if (pointerSize !== 4 && pointerSize !== 8) throw new Error('Invalid pointer width.')
  if (type === 'pointer') return pointerSize
  if (type === 'utf8' || type === 'bytes') return 1
  if (type === 'utf16') return 2
  return Number(String(type).slice(1)) / 8
}

export function encodeValue(type: unknown, value: unknown, pointerSize: number): Buffer {
  const size = valueSize(type, pointerSize)
  if (typeof value !== 'string' || value.length > 32768)
    throw new Error('Typed values must be strings of at most 32768 characters.')
  if (type === 'bytes') {
    if (!/^(?:[a-f0-9]{2})+$/i.test(value))
      throw new Error('Byte values require complete hex pairs.')
    return Buffer.from(value, 'hex')
  }
  if (type === 'utf8' || type === 'utf16') {
    const bytes = Buffer.from(value, type === 'utf8' ? 'utf8' : 'utf16le')
    if (!bytes.length || bytes.length > 65536)
      throw new Error('Encoded text requires 1..65536 bytes. No terminator is appended.')
    return bytes
  }
  const bytes = Buffer.alloc(size)
  if (type === 'f32' || type === 'f64') {
    if (
      !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
      !Number.isFinite(Number(value))
    )
      throw new Error('Expected a finite numeric string.')
    if (type === 'f32') {
      bytes.writeFloatLE(Number(value))
      if (!Number.isFinite(bytes.readFloatLE())) throw new Error('Float32 overflow.')
    } else bytes.writeDoubleLE(Number(value))
    return bytes
  }
  if (!/^-?\d+$/.test(value) && !(type === 'pointer' && /^0x[\da-f]+$/i.test(value)))
    throw new Error('Expected decimal integer string (pointer may use 0x hex).')
  const integer = BigInt(value),
    bits = BigInt(size * 8),
    signed = String(type).startsWith('i')
  const minimum = signed ? -(1n << (bits - 1n)) : 0n
  const maximum = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n
  if (integer < minimum || integer > maximum)
    throw new Error('Value is outside the selected type range.')
  let unsigned = BigInt.asUintN(size * 8, integer)
  for (let i = 0; i < size; i++) {
    bytes[i] = Number(unsigned & 255n)
    unsigned >>= 8n
  }
  return bytes
}

export function decodeValue(type: unknown, bytes: Buffer, pointerSize: number, count = 1): unknown {
  const size = valueSize(type, pointerSize)
  if (!Number.isInteger(count) || count < 1 || count > 4096 || bytes.length !== size * count)
    throw new Error('Incomplete typed value bytes.')
  if (type === 'bytes') return bytes.toString('hex')
  if (type === 'utf8' || type === 'utf16')
    return bytes.toString(type === 'utf8' ? 'utf8' : 'utf16le')
  const result: (string | number)[] = []
  for (let offset = 0; offset < bytes.length; offset += size) {
    if (type === 'f32' || type === 'f64') {
      const value = type === 'f32' ? bytes.readFloatLE(offset) : bytes.readDoubleLE(offset)
      result.push(Number.isFinite(value) ? value : String(value))
    } else {
      let integer = 0n
      for (let i = size - 1; i >= 0; i--) integer = (integer << 8n) | BigInt(bytes[offset + i])
      if (String(type).startsWith('i')) integer = BigInt.asIntN(size * 8, integer)
      result.push(type === 'pointer' ? '0x' + integer.toString(16) : integer.toString())
    }
  }
  return count === 1 ? result[0] : result
}
