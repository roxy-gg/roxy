import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat, mkdir, mkdtemp } from 'node:fs/promises'
import { isAbsolute, join, extname } from 'node:path'

function command(
  file: string,
  args: string[],
  signal?: AbortSignal,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean } = {}
): Promise<{ code: number | null; output: string; truncated: boolean }> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let aborted = false
    const cancel = (): void => {
      if (aborted) return
      aborted = true
      if (child.pid) {
        const killer = spawn(
          join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' }
        )
        killer.on('error', () => {
          child.kill()
        })
        killer.unref()
      }
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    let output = '',
      truncated = false
    const append = (data: Buffer): void => {
      const value = output + data.toString()
      truncated ||= value.length > 64000
      output = value.slice(-64000)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error) => {
      signal?.removeEventListener('abort', cancel)
      reject(error)
    })
    child.once('close', (code) => {
      signal?.removeEventListener('abort', cancel)
      if (aborted) reject(signal?.reason ?? new Error('DLL build cancelled'))
      else resolve({ code, output, truncated })
    })
  })
}

export async function buildCheatDll(
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const deadline = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])])
  deadline.throwIfAborted()
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('DLL builds require Windows x64.')
  if (
    typeof input.name !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(input.name) ||
    !Array.isArray(input.sources) ||
    input.sources.length < 1 ||
    input.sources.length > 16 ||
    new Set(input.sources).size !== input.sources.length
  )
    throw new Error('Supply a safe artifact name and 1..16 unique absolute C++ source paths.')
  const includes = input.include_dirs ?? []
  if (!Array.isArray(includes) || includes.length > 16)
    throw new Error('At most 16 include directories are supported.')
  const sources: { path: string; sha256: string }[] = []
  let bytes = 0
  for (const path of input.sources) {
    deadline.throwIfAborted()
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      path.includes('\0') ||
      !['.cpp', '.cc', '.cxx'].includes(extname(path).toLowerCase())
    )
      throw new Error('Expected absolute .cpp/.cc/.cxx source path.')
    const info = await stat(path)
    if (!info.isFile() || info.size > 1024 * 1024 || (bytes += info.size) > 8 * 1024 * 1024)
      throw new Error('Source exceeds the 1 MiB per-file / 8 MiB aggregate budget.')
    sources.push({
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    })
  }
  for (const path of includes)
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      path.includes('\0') ||
      !(await stat(path)).isDirectory()
    )
      throw new Error('Expected absolute include directory.')
  const vswhere = join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe'
  )
  const found = await command(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath'
    ],
    deadline
  )
  const installation = found.output.trim()
  if (found.code !== 0 || !isAbsolute(installation) || /[\r\n"%&|<>^!]/.test(installation))
    throw new Error(
      'Installed Visual Studio C++ build tools were not found. Install them explicitly; Roxy does not install toolchains.'
    )
  const devcmd = join(installation, 'Common7/Tools/VsDevCmd.bat')
  const initialized = await command(
    join(process.env.SystemRoot || 'C:\\Windows', 'System32/cmd.exe'),
    ['/d', '/s', '/c', `""${devcmd}" -no_logo -arch=amd64 -host_arch=amd64 >nul && set"`],
    deadline,
    { windowsVerbatimArguments: true }
  )
  if (initialized.code !== 0 || initialized.truncated)
    throw new Error('Visual Studio build environment could not be initialized.')
  const env: NodeJS.ProcessEnv = {}
  for (const line of initialized.output.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (
      separator > 0 &&
      !['cl', '_cl_', 'link', '_link_'].includes(line.slice(0, separator).toLowerCase())
    )
      env[line.slice(0, separator)] = line.slice(separator + 1)
  }
  const tools = Object.entries(env).find(([key]) => key.toLowerCase() === 'vctoolsinstalldir')?.[1]
  if (!tools) throw new Error('Visual Studio did not report VCToolsInstallDir.')
  const directory = join(app.getPath('userData'), 'cheat-tools', 'builds')
  await mkdir(directory, { recursive: true })
  const cwd = await mkdtemp(join(directory, input.name + '-'))
  const path = join(cwd, input.name + '.dll')
  // Explicit argv only. No MSBuild projects, response files supplied by the
  // caller, compiler plugins, custom build hooks, or execution of the artifact.
  const result = await command(
    join(tools, 'bin/Hostx64/x64/cl.exe'),
    [
      '/nologo',
      '/LD',
      '/EHsc',
      '/std:c++20',
      '/W4',
      '/MD',
      '/utf-8',
      ...includes.map((dir) => '/I' + dir),
      ...sources.map((s) => '/Tp' + s.path),
      '/link',
      '/OUT:' + path,
      '/INCREMENTAL:NO'
    ],
    deadline,
    { cwd, env }
  )
  if (result.code !== 0)
    return {
      built: false,
      exitCode: result.code,
      diagnostics: result.output,
      diagnosticsTruncated: result.truncated,
      directory: cwd,
      executed: false
    }
  const artifact = await stat(path)
  if (!artifact.isFile() || artifact.size > 64 * 1024 * 1024)
    throw new Error('Compiler artifact is missing or exceeds 64 MiB.')
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
  deadline.throwIfAborted()
  return {
    built: true,
    path,
    sha256,
    bytes: artifact.size,
    architecture: 'x64',
    sources,
    diagnostics: result.output,
    diagnosticsTruncated: result.truncated,
    executed: false,
    limitation:
      'Source hashes are pre-build observations, not an atomic snapshot of sources or transitive headers. Build output is not signed, trusted or automatically loaded.'
  }
}
