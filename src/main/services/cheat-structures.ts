import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { valueSize, decodeValue } from './cheat-values'
import type { CheatValueType } from '../../shared/cheat'

interface Field {
  name: string
  offset: number
  type: CheatValueType
  count: number
}
interface Structure {
  name: string
  size: number
  pointer_size: number
  revision: number
  fields: Field[]
}
type Execute = (input: Record<string, unknown>) => Promise<Record<string, unknown>>
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)

function definition(input: Record<string, unknown>, revision: number): Structure {
  if (
    !identifier(input.name) ||
    !Number.isInteger(input.size) ||
    Number(input.size) < 1 ||
    Number(input.size) > 65536 ||
    ![4, 8].includes(Number(input.pointer_size)) ||
    typeof input.pointer_size !== 'number' ||
    !Array.isArray(input.fields) ||
    input.fields.length < 1 ||
    input.fields.length > 256
  )
    throw new Error('Invalid explicit structure definition.')
  const seen = new Set<string>()
  const fields = input.fields
    .map((entry: unknown): Field => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('Invalid structure field.')
      const field = entry as Record<string, unknown>
      const count = field.count ?? 1
      if (
        Object.keys(field).some((key) => !['name', 'offset', 'type', 'count'].includes(key)) ||
        !identifier(field.name) ||
        seen.has(field.name) ||
        !Number.isInteger(field.offset) ||
        Number(field.offset) < 0 ||
        !Number.isInteger(count) ||
        Number(count) < 1 ||
        Number(count) > 4096
      )
        throw new Error(
          'Fields require unique names, nonnegative integer offsets and counts of 1..4096.'
        )
      const size = valueSize(field.type, input.pointer_size as number) * Number(count)
      if (Number(field.offset) + size > Number(input.size))
        throw new Error('Field exceeds explicit structure size.')
      seen.add(field.name)
      return {
        name: field.name,
        offset: Number(field.offset),
        type: field.type as CheatValueType,
        count: Number(count)
      }
    })
    .sort((a, b) => a.offset - b.offset)
  let end = 0
  for (const field of fields) {
    if (field.offset < end) throw new Error('Overlapping structure fields are unsupported.')
    end = field.offset + valueSize(field.type, input.pointer_size as number) * field.count
  }
  return {
    name: input.name,
    size: Number(input.size),
    pointer_size: input.pointer_size as number,
    revision,
    fields
  }
}

export async function runStructureTool(
  root: string,
  owner: string,
  operation: string,
  input: Record<string, unknown>,
  execute: Execute,
  pointerSize?: number
): Promise<Record<string, unknown>> {
  const folder = join(root, 'structures', createHash('sha256').update(owner).digest('hex'))
  if (operation !== 'structure_list' && !identifier(input.name))
    throw new Error('Invalid structure name.')
  const path = join(folder, String(input.name).toLowerCase() + '.json')
  const load = async (file: string): Promise<Structure> => {
    const info = await stat(file)
    if (!info.isFile() || info.size > 262144) throw new Error('Structure metadata exceeds budget.')
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (!Number.isInteger(data.revision) || data.revision < 1 || data.revision > 2147483647)
      throw new Error('Invalid persisted revision.')
    return definition(data, data.revision)
  }
  if (operation === 'structure_list') {
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 128))
      throw new Error('Invalid structure query.')
    let files: string[]
    try {
      files = (await readdir(folder)).filter((file) => /^[a-z][a-z0-9_]{0,63}\.json$/.test(file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { structures: [] }
      throw error
    }
    const rows: Structure[] = []
    const issues: { file: string; error: string }[] = []
    for (const file of files.sort().slice(0, 64)) {
      try {
        const data = await load(join(folder, file))
        if (
          JSON.stringify(data)
            .toLowerCase()
            .includes(String(input.query ?? '').toLowerCase())
        )
          rows.push(data)
      } catch (error) {
        issues.push({ file, error: String(error) })
      }
    }
    return {
      structures: rows,
      issues,
      capped: files.length > 64,
      namespace: 'Roxy definitions, not live ReClass objects'
    }
  }
  if (operation === 'structure_create' || operation === 'structure_update') {
    let revision = 1
    if (operation === 'structure_update') {
      const existing = await load(path)
      if (input.revision !== existing.revision || existing.revision >= 2147483647)
        throw new Error('Structure revision conflict; read current definition first.')
      revision = existing.revision + 1
    }
    const data = definition(input, revision)
    await mkdir(folder, { recursive: true })
    if (operation === 'structure_create') {
      if ((await readdir(folder)).filter((f) => f.endsWith('.json')).length >= 64)
        throw new Error('At most 64 structures per chat/actor.')
      await writeFile(path, JSON.stringify(data), { flag: 'wx' })
    } else {
      await writeFile(path + '.partial', JSON.stringify(data))
      await rename(path + '.partial', path)
    }
    return { structure: data, persisted: true, targetModified: false }
  }
  const data = await load(path)
  if (operation === 'structure_read') return { structure: data }
  if (operation === 'structure_delete') {
    if (input.revision !== data.revision) throw new Error('Structure revision conflict.')
    await unlink(path)
    return { deleted: true, targetModified: false }
  }
  if (operation === 'read_structure') {
    if (pointerSize !== data.pointer_size)
      throw new Error('Structure pointer width does not match selected process.')
    const result = await execute({
      operation: 'read_memory',
      address: input.address,
      length: data.size
    })
    const bytes = Buffer.from(String(result.hex ?? ''), 'hex')
    return {
      structure: data.name,
      revision: data.revision,
      ...result,
      fields: data.fields.map((field) => {
        const size = valueSize(field.type, data.pointer_size) * field.count
        const complete = bytes.length >= field.offset + size
        return {
          ...field,
          complete,
          ...(complete
            ? {
                value: decodeValue(
                  field.type,
                  bytes.subarray(field.offset, field.offset + size),
                  data.pointer_size,
                  field.count
                )
              }
            : {})
        }
      }),
      layoutAuthority: 'Explicit user-defined offsets, not inferred source types',
      snapshot: false
    }
  }
  if (operation === 'export_structure') {
    const cpp: Record<string, string> = {
      i8: 'std::int8_t',
      u8: 'std::uint8_t',
      i16: 'std::int16_t',
      u16: 'std::uint16_t',
      i32: 'std::int32_t',
      u32: 'std::uint32_t',
      i64: 'std::int64_t',
      u64: 'std::uint64_t',
      f32: 'float',
      f64: 'double',
      pointer: `std::uint${data.pointer_size * 8}_t`,
      utf8: 'char',
      utf16: 'char16_t',
      bytes: 'std::uint8_t'
    }
    // Prefix all identifiers so user names cannot collide with C++ keywords,
    // padding declarations, or implementation-reserved underscore names.
    const lines = [
      '#pragma once',
      '#include <cstddef>',
      '#include <cstdint>',
      '#pragma pack(push, 1)',
      `struct Roxy_${data.name} {`
    ]
    let end = 0,
      padding = 0
    for (const field of data.fields) {
      if (field.offset > end)
        lines.push(`  std::uint8_t padding_${padding++}[${field.offset - end}];`)
      lines.push(
        `  ${cpp[field.type]} field_${field.name}${field.count > 1 ? `[${field.count}]` : ''};`
      )
      end = field.offset + valueSize(field.type, data.pointer_size) * field.count
    }
    if (data.size > end) lines.push(`  std::uint8_t padding_${padding}[${data.size - end}];`)
    lines.push(
      '};',
      '#pragma pack(pop)',
      `static_assert(sizeof(Roxy_${data.name}) == ${data.size});`
    )
    for (const field of data.fields)
      lines.push(
        `static_assert(offsetof(Roxy_${data.name}, field_${field.name}) == ${field.offset});`
      )
    return {
      language: 'cpp',
      code: lines.join('\n') + '\n',
      revision: data.revision,
      sourceRecovered: false,
      pointerSemantics: 'Fixed-width integer storage, no automatic dereference'
    }
  }
  throw new Error('Unknown structure operation.')
}
