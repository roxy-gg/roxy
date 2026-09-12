import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { KernelInstallResult, KernelStatus } from '../../shared/kernel'
import { deleteMcpServer, listMcpServers, upsertMcpServer } from '../db/repo'
import { disposeConnection } from './mcp'

const execFileAsync = promisify(execFile)

const REPOSITORY_URL = 'https://github.com/roxy-gg/kernel-tools.git'
// Review and update this pin deliberately when the external driver changes.
const REPOSITORY_REVISION = '2f51a1d5981a553d7642db9c81d41a002f3c44e4'
const SERVICE_NAME = 'AIBridge'
const MCP_SERVER_ID = 'roxy-kernel-tools'
const MCP_SERVER_IDS = [MCP_SERVER_ID, 'kernel'] as const

const INSTALL_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local'),
  'roxy',
  'kernel-tools'
)
const REPOSITORY_DIR = path.join(INSTALL_DIR, 'repo')
const OUTPUT_DIR = path.join(REPOSITORY_DIR, 'out')
const BUILT_DRIVER_PATH = path.join(OUTPUT_DIR, 'aibridge.sys')
const BUILT_BRIDGE_PATH = path.join(OUTPUT_DIR, 'roxy-kernel-bridge.exe')
const PRIVILEGED_INSTALL_DIR = path.join(
  process.env.ProgramFiles ?? 'C:\\Program Files',
  'Roxy',
  'KernelTools'
)
const DRIVER_PATH = path.join(PRIVILEGED_INSTALL_DIR, 'aibridge.sys')
const BRIDGE_PATH = path.join(PRIVILEGED_INSTALL_DIR, 'roxy-kernel-bridge.exe')

function isWindows(): boolean {
  return process.platform === 'win32'
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const output = error as Error & { stdout?: string; stderr?: string }
  const details = [output.stderr, output.stdout]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join('\n')
  return details ? `${error.message}\n${details}` : error.message
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function systemExecutable(name: string): string {
  const windowsDirectory = process.env.SystemRoot ?? 'C:\\Windows'
  return path.join(windowsDirectory, 'System32', name)
}

async function run(
  file: string,
  args: string[],
  timeout = 30_000
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, { timeout, windowsHide: true })
}

/** Run one executable through the standard Windows UAC consent prompt. */
async function runElevated(file: string, args: string[], timeout = 120_000): Promise<void> {
  const argumentList = args.map(powershellLiteral).join(', ')
  const resultPath = path.join(INSTALL_DIR, `elevated-${randomUUID()}.txt`)
  const command = [
    `$resultPath = ${powershellLiteral(resultPath)}`,
    'try {',
    `  $process = Start-Process -FilePath ${powershellLiteral(file)} -ArgumentList @(${argumentList}) -Verb RunAs -Wait -PassThru`,
    "  $result = if ($null -eq $process) { '1`nThe elevated process did not start.' } elseif ($process.ExitCode -eq 0) { '0' } else { \"$($process.ExitCode)`nThe elevated command failed.\" }",
    '} catch { $result = "1`n$($_.Exception.Message)" }',
    'Set-Content -LiteralPath $resultPath -Value $result -Encoding UTF8'
  ].join('; ')

  mkdirSync(INSTALL_DIR, { recursive: true })
  try {
    await run(
      systemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      timeout
    )
    const [exitCode, ...details] = readFileSync(resultPath, 'utf8')
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/)
    if (exitCode !== '0') {
      throw new Error(details.join('\n') || `Elevated command exited with code ${exitCode}.`)
    }
  } finally {
    await rm(resultPath, { force: true })
  }
}
export async function checkTestSigning(): Promise<boolean> {
  if (!isWindows()) return false
  try {
    const { stdout } = await run(
      systemExecutable('reg.exe'),
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control', '/v', 'SystemStartOptions'],
      5_000
    )
    return /\bTESTSIGNING\b/i.test(stdout)
  } catch {
    return false
  }
}

async function setTestSigning(enable: boolean): Promise<void> {
  await runElevated(systemExecutable('bcdedit.exe'), ['/set', 'testsigning', enable ? 'on' : 'off'])
}

function installedDriverScript(
  expectedDriverHash: string,
  expectedBridgeHash: string,
  startDriver: boolean
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$installDirectory = ${powershellLiteral(PRIVILEGED_INSTALL_DIR)}`,
    `$driverSource = ${powershellLiteral(BUILT_DRIVER_PATH)}`,
    `$driverTarget = ${powershellLiteral(DRIVER_PATH)}`,
    `$bridgeSource = ${powershellLiteral(BUILT_BRIDGE_PATH)}`,
    `$bridgeTarget = ${powershellLiteral(BRIDGE_PATH)}`,
    `$expectedDriverHash = ${powershellLiteral(expectedDriverHash)}`,
    `$expectedBridgeHash = ${powershellLiteral(expectedBridgeHash)}`,
    "if ((Get-FileHash -Algorithm SHA256 $driverSource).Hash.ToLowerInvariant() -ne $expectedDriverHash) { throw 'Driver hash mismatch.' }",
    "if ((Get-FileHash -Algorithm SHA256 $bridgeSource).Hash.ToLowerInvariant() -ne $expectedBridgeHash) { throw 'Bridge hash mismatch.' }",
    `$service = Get-Service -Name ${powershellLiteral(SERVICE_NAME)} -ErrorAction SilentlyContinue`,
    'if ($service) {',
    `  & sc.exe stop ${SERVICE_NAME} | Out-Null`,
    '  Start-Sleep -Seconds 1',
    `  & sc.exe delete ${SERVICE_NAME} | Out-Null`,
    '  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1060) { exit $LASTEXITCODE }',
    '  Start-Sleep -Seconds 1',
    '}',
    'New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null',
    'Copy-Item -Force $driverSource $driverTarget',
    'Copy-Item -Force $bridgeSource $bridgeTarget',
    "if ((Get-FileHash -Algorithm SHA256 $driverTarget).Hash.ToLowerInvariant() -ne $expectedDriverHash) { throw 'Installed driver hash mismatch.' }",
    "if ((Get-FileHash -Algorithm SHA256 $bridgeTarget).Hash.ToLowerInvariant() -ne $expectedBridgeHash) { throw 'Installed bridge hash mismatch.' }",
    `& sc.exe create ${SERVICE_NAME} 'type=' 'kernel' 'start=' 'demand' 'binPath=' $driverTarget | Out-Null`,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    startDriver ? `& sc.exe start ${SERVICE_NAME} | Out-Null` : 'exit 0',
    startDriver ? 'exit $LASTEXITCODE' : ''
  ].join('; ')
}
function uninstallDriverScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$service = Get-Service -Name ${powershellLiteral(SERVICE_NAME)} -ErrorAction SilentlyContinue`,
    'if ($service) {',
    `  & sc.exe stop ${SERVICE_NAME} | Out-Null`,
    '  Start-Sleep -Seconds 1',
    `  & sc.exe delete ${SERVICE_NAME} | Out-Null`,
    '  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1060) { exit $LASTEXITCODE }',
    '}',
    `Remove-Item -Force ${powershellLiteral(DRIVER_PATH)} -ErrorAction SilentlyContinue`,
    `Remove-Item -Force ${powershellLiteral(BRIDGE_PATH)} -ErrorAction SilentlyContinue`,
    `if (Test-Path ${powershellLiteral(DRIVER_PATH)}) { throw 'The installed driver file could not be removed.' }`,
    `if (Test-Path ${powershellLiteral(BRIDGE_PATH)}) { throw 'The installed bridge file could not be removed.' }`,
    `if (Test-Path ${powershellLiteral(PRIVILEGED_INSTALL_DIR)}) { Remove-Item -Force ${powershellLiteral(PRIVILEGED_INSTALL_DIR)} -ErrorAction SilentlyContinue }`
  ].join('; ')
}

async function getDriverServiceState(): Promise<KernelStatus['driverState']> {
  try {
    const { stdout } = await run(
      systemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$service = Get-Service -Name ${powershellLiteral(SERVICE_NAME)} -ErrorAction SilentlyContinue; if ($service) { [int]$service.Status } else { 0 }`
      ],
      5_000
    )
    if (stdout.trim() === '4') return 'running'
    if (stdout.trim() === '1') return 'stopped'
    if (stdout.trim() === '0') return 'not-installed'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

async function isProcessElevated(): Promise<boolean> {
  try {
    const { stdout } = await run(
      systemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ],
      5_000
    )
    return stdout.trim().toLowerCase() === 'true'
  } catch {
    return false
  }
}
function hasKernelMcpServer(): boolean {
  return listMcpServers().some(
    (server) =>
      MCP_SERVER_IDS.includes(server.id as (typeof MCP_SERVER_IDS)[number]) &&
      server.enabled &&
      server.config.type === 'local' &&
      path.resolve(server.config.command[0] ?? '') === path.resolve(BRIDGE_PATH)
  )
}

async function removeKernelMcpServers(): Promise<void> {
  for (const id of MCP_SERVER_IDS) {
    const server = listMcpServers().find((record) => record.id === id)
    if (
      server?.config.type === 'local' &&
      path.resolve(server.config.command[0] ?? '') === path.resolve(BRIDGE_PATH)
    ) {
      await disposeConnection(id)
      deleteMcpServer(id)
    }
  }
}

export async function setKernelAgentAccess(enable: boolean): Promise<KernelInstallResult> {
  if (!isWindows()) return { ok: false, error: 'Kernel tools require Windows.', steps: [] }
  const steps: string[] = []

  try {
    await removeKernelMcpServers()
    if (!enable) {
      steps.push('Agent access disabled.')
      return { ok: true, steps }
    }

    const status = await getKernelStatus()
    if (!status.installed || !status.bridgePath || status.driverState !== 'running') {
      throw new Error('Install and start Kernel Tools before enabling agent access.')
    }

    if (!(await isProcessElevated())) {
      throw new Error(
        'Restart Roxy as administrator before enabling agent access. Roxy must remain elevated while using these tools.'
      )
    }

    const existing = listMcpServers().find((record) => record.id === MCP_SERVER_ID)
    if (existing) throw new Error(`An MCP server named ${MCP_SERVER_ID} already exists.`)

    upsertMcpServer({
      id: MCP_SERVER_ID,
      config: { type: 'local', command: [status.bridgePath], cwd: path.dirname(status.bridgePath) },
      enabled: true
    })
    steps.push('Agent access enabled through the roxy-kernel-tools MCP server.')
    return { ok: true, steps }
  } catch (error) {
    return { ok: false, error: errorMessage(error), steps }
  }
}

export async function getKernelStatus(): Promise<KernelStatus> {
  if (!isWindows()) {
    return {
      isWindows: false,
      installed: false,
      hasArtifacts: false,
      driverPath: null,
      testSigning: false,
      bridgePath: null,
      mcpRegistered: false,
      driverState: 'not-installed'
    }
  }

  const [testSigning, driverState] = await Promise.all([
    checkTestSigning(),
    getDriverServiceState()
  ])
  const driverPath = existsSync(DRIVER_PATH) ? DRIVER_PATH : null
  const bridgePath = existsSync(BRIDGE_PATH) ? BRIDGE_PATH : null

  let mcpRegistered = false
  try {
    mcpRegistered = hasKernelMcpServer()
  } catch {
    // The database may still be opening during app startup.
  }

  return {
    isWindows: true,
    installed: driverPath !== null && bridgePath !== null && driverState !== 'not-installed',
    hasArtifacts: driverPath !== null || bridgePath !== null || driverState !== 'not-installed',
    driverPath,
    testSigning,
    bridgePath,
    mcpRegistered,
    driverState
  }
}

async function checkoutPinnedRepository(steps: string[]): Promise<void> {
  steps.push('Downloading the pinned kernel-tools source...')
  await rm(REPOSITORY_DIR, { recursive: true, force: true })
  mkdirSync(INSTALL_DIR, { recursive: true })
  await run('git.exe', ['clone', '--no-checkout', REPOSITORY_URL, REPOSITORY_DIR], 120_000)
  await run('git.exe', ['-C', REPOSITORY_DIR, 'checkout', '--detach', REPOSITORY_REVISION], 30_000)
}

async function buildArtifacts(steps: string[]): Promise<void> {
  const powershell = systemExecutable('WindowsPowerShell\\v1.0\\powershell.exe')

  steps.push('Building the Windows kernel driver...')
  await run(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(REPOSITORY_DIR, 'driver', 'build.ps1')
    ],
    10 * 60_000
  )

  steps.push('Building the MCP bridge...')
  await run(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(REPOSITORY_DIR, 'bridge', 'build.ps1')
    ],
    10 * 60_000
  )

  if (!existsSync(BUILT_DRIVER_PATH) || !existsSync(BUILT_BRIDGE_PATH)) {
    throw new Error('The external build completed without producing both required binaries.')
  }
}

export async function installKernelTools(): Promise<KernelInstallResult> {
  if (!isWindows()) return { ok: false, error: 'Kernel tools require Windows.', steps: [] }
  const steps: string[] = []
  let enabledTestSigning = false

  try {
    await removeKernelMcpServers()
    await checkoutPinnedRepository(steps)
    await buildArtifacts(steps)

    const testSigningWasEnabled = await checkTestSigning()
    if (!testSigningWasEnabled) {
      steps.push('Requesting administrator approval to enable Windows test signing...')
      await setTestSigning(true)
      enabledTestSigning = true
      steps.push('Test signing enabled. Restart Windows before starting the driver.')
    } else {
      steps.push('Windows test signing is already enabled.')
    }

    steps.push('Requesting administrator approval to install the driver service...')
    await runElevated(systemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      installedDriverScript(
        sha256(BUILT_DRIVER_PATH),
        sha256(BUILT_BRIDGE_PATH),
        testSigningWasEnabled
      )
    ])
    const driverState = await getDriverServiceState()
    if (driverState === 'running') {
      steps.push('Driver started. Agent access is not enabled automatically.')
      return { ok: true, steps }
    }
    if (!testSigningWasEnabled && driverState === 'stopped') {
      steps.push('Driver service installed. Restart Windows, then return here and start it.')
      return { ok: true, steps }
    }
    throw new Error('The driver service was not installed successfully.')
  } catch (error) {
    if (enabledTestSigning) {
      try {
        await setTestSigning(false)
        steps.push('Test signing was disabled again because installation failed.')
      } catch {
        steps.push(
          'Installation failed after enabling test signing; disable it manually if needed.'
        )
      }
    }
    return { ok: false, error: errorMessage(error), steps }
  }
}

export async function startKernelDriver(): Promise<KernelInstallResult> {
  if (!isWindows()) return { ok: false, error: 'Kernel tools require Windows.', steps: [] }
  const steps: string[] = []

  if (!existsSync(DRIVER_PATH) || !existsSync(BRIDGE_PATH)) {
    return { ok: false, error: 'Install kernel tools before starting the driver.', steps }
  }

  try {
    steps.push('Requesting administrator approval to start the driver...')
    await runElevated(systemExecutable('sc.exe'), ['start', SERVICE_NAME])
    if ((await getDriverServiceState()) !== 'running') {
      throw new Error('The driver did not enter the running state.')
    }
    steps.push('Driver started. Agent access remains disabled until you enable it.')
    return { ok: true, steps }
  } catch (error) {
    return { ok: false, error: errorMessage(error), steps }
  }
}

export async function toggleTestSigning(enable: boolean): Promise<KernelInstallResult> {
  if (!isWindows()) return { ok: false, error: 'Kernel tools require Windows.', steps: [] }
  const steps: string[] = []

  try {
    steps.push(
      `Requesting administrator approval to ${enable ? 'enable' : 'disable'} test signing...`
    )
    await setTestSigning(enable)
    steps.push(`Test signing ${enable ? 'enabled' : 'disabled'}. Restart Windows to apply.`)
    return { ok: true, steps }
  } catch (error) {
    return { ok: false, error: errorMessage(error), steps }
  }
}

export async function uninstallKernelTools(disableSigning: boolean): Promise<KernelInstallResult> {
  if (!isWindows()) return { ok: false, error: 'Kernel tools require Windows.', steps: [] }
  const steps: string[] = []

  try {
    await removeKernelMcpServers()
    steps.push('Agent access disabled.')

    if (
      existsSync(DRIVER_PATH) ||
      existsSync(BRIDGE_PATH) ||
      (await getDriverServiceState()) !== 'not-installed'
    ) {
      steps.push('Requesting administrator approval to remove the driver service...')
      await runElevated(systemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        uninstallDriverScript()
      ])
      if (
        (await getDriverServiceState()) !== 'not-installed' ||
        existsSync(DRIVER_PATH) ||
        existsSync(BRIDGE_PATH)
      ) {
        throw new Error('The driver service could not be fully removed.')
      }
      steps.push('Driver service and bridge removed.')
    }

    if (disableSigning) {
      await setTestSigning(false)
      steps.push('Test signing disabled. Restart Windows to apply.')
    }

    await rm(INSTALL_DIR, { recursive: true, force: true })
    steps.push('Downloaded kernel-tools files removed.')
    return { ok: true, steps }
  } catch (error) {
    return { ok: false, error: errorMessage(error), steps }
  }
}
