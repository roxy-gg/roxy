import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, net as electronNet } from 'electron'
import type { KernelInstallResult, KernelStatus } from '../../shared/kernel'
import { deleteMcpServer, listMcpServers, upsertMcpServer } from '../db/repo'
import { disposeConnection } from './mcp'

const execFileAsync = promisify(execFile)

const RELEASE_TAG = 'v1.0.2'
const RELEASE_ASSET = 'kernel-tools-windows-x64.zip'
const RELEASE_URL = `https://github.com/roxy-gg/kernel-tools/releases/download/${RELEASE_TAG}/${RELEASE_ASSET}`
const RELEASE_SHA256 = 'c3e0b19f69c13d4bb4ffb55987f13b3f4e6232a92245645e98acccf5cee2c4f5'
const RELEASE_COMMIT = '62126a86e335caee1a04fdfc8db08986638112d7'
const SIGNER_THUMBPRINT = 'f1b5ab3fa912b6bc5ae30301dd36b64708f293cf'
const BRIDGE_SHA256 = '48e24b722c77394416801bc1c6a19dcff109561942fe03f6590056b2b730563a'
const MAX_RELEASE_BYTES = 5 * 1024 * 1024
const SERVICE_NAME = 'RoxyKernelToolsAIBridge'
const MCP_SERVER_ID = 'roxy-kernel-tools'
const MCP_SERVER_IDS = [MCP_SERVER_ID, 'kernel'] as const

const INSTALL_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local'),
  'roxy',
  'kernel-tools'
)
const ARCHIVE_PATH = path.join(INSTALL_DIR, RELEASE_ASSET)
const PRIVILEGED_INSTALL_DIR = path.join(
  process.env.ProgramFiles ?? 'C:\\Program Files',
  'Roxy',
  'KernelTools'
)
const DRIVER_PATH = path.join(PRIVILEGED_INSTALL_DIR, 'aibridge.sys')
const BRIDGE_PATH = path.join(PRIVILEGED_INSTALL_DIR, 'roxy-kernel-bridge.exe')
const INSTALL_MANIFEST_PATH = path.join(PRIVILEGED_INSTALL_DIR, 'install-manifest.json')
let mutationInProgress = false

function isWindows(): boolean {
  return process.platform === 'win32'
}

function isSupportedPlatform(): boolean {
  return isWindows() && process.arch === 'x64'
}

async function runMutation(
  operation: () => Promise<KernelInstallResult>
): Promise<KernelInstallResult> {
  if (mutationInProgress) {
    return { ok: false, error: 'Another Kernel Tools operation is already in progress.', steps: [] }
  }
  mutationInProgress = true
  try {
    return await operation()
  } finally {
    mutationInProgress = false
  }
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
  return execFileAsync(file, args, { timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
}

/** Run one executable through the standard Windows UAC consent prompt. */
async function runElevated(file: string, args: string[]): Promise<void> {
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
      0
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

function installedDriverScript(startDriver: boolean): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$archivePath = ${powershellLiteral(ARCHIVE_PATH)}`,
    `$expectedArchiveHash = ${powershellLiteral(RELEASE_SHA256)}`,
    `$expectedVersion = ${powershellLiteral(RELEASE_TAG)}`,
    `$expectedCommit = ${powershellLiteral(RELEASE_COMMIT)}`,
    `$expectedSignerThumbprint = ${powershellLiteral(SIGNER_THUMBPRINT)}`,
    `$expectedBridgeHash = ${powershellLiteral(BRIDGE_SHA256)}`,
    `$installDirectory = ${powershellLiteral(PRIVILEGED_INSTALL_DIR)}`,
    `$driverTarget = ${powershellLiteral(DRIVER_PATH)}`,
    `$bridgeTarget = ${powershellLiteral(BRIDGE_PATH)}`,
    `$installManifestPath = ${powershellLiteral(INSTALL_MANIFEST_PATH)}`,
    `$stagingDirectory = Join-Path $installDirectory ('.staging-' + [guid]::NewGuid().ToString('N'))`,
    'try {',
    '  New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null',
    '  $archive = [IO.File]::Open($archivePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)',
    '  try {',
    '    $archiveHash = [Security.Cryptography.SHA256]::Create().ComputeHash($archive)',
    "    $archiveHashHex = (($archiveHash | ForEach-Object { $_.ToString('x2') }) -join '')",
    "    if ($archiveHashHex -ne $expectedArchiveHash) { throw 'Release archive hash mismatch.' }",
    '    $archive.Position = 0',
    '    New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null',
    "    Add-Type -AssemblyName 'System.IO.Compression'",
    "  Add-Type -AssemblyName 'System.IO.Compression.FileSystem'",
    '    $zip = New-Object IO.Compression.ZipArchive($archive, [IO.Compression.ZipArchiveMode]::Read, $true)',
    '    try {',
    "      $allowedNames = @('aibridge-test.cer', 'aibridge.sys', 'manifest.json', 'roxy-kernel-bridge.exe')",
    "      if ($zip.Entries.Count -ne $allowedNames.Count -or @($zip.Entries | Where-Object { $_.FullName -notin $allowedNames }).Count -ne 0) { throw 'Unexpected release archive contents.' }",
    '      foreach ($entry in $zip.Entries) {',
    '        $destination = Join-Path $stagingDirectory $entry.FullName',
    '        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)',
    '      }',
    '    } finally { $zip.Dispose() }',
    '  } finally { $archive.Dispose() }',
    '$manifest = Get-Content -Raw -LiteralPath (Join-Path $stagingDirectory "manifest.json") | ConvertFrom-Json',
    "if ($manifest.version -ne $expectedVersion -or $manifest.architecture -ne 'x64' -or $manifest.sourceCommit -ne $expectedCommit -or -not $manifest.testSigned -or $manifest.signerThumbprint.ToLowerInvariant() -ne $expectedSignerThumbprint) { throw 'Release manifest mismatch.' }",
    "$expectedNames = @('aibridge-test.cer', 'aibridge.sys', 'roxy-kernel-bridge.exe')",
    "if ($manifest.files.Count -ne $expectedNames.Count -or @($manifest.files | Where-Object { $_.name -notin $expectedNames }).Count -ne 0) { throw 'Unexpected release manifest file set.' }",
    'foreach ($file in $manifest.files) {',
    '  $filePath = Join-Path $stagingDirectory $file.name',
    "  if ((Get-Item -LiteralPath $filePath).Length -ne $file.size -or (Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash.ToLowerInvariant() -ne $file.sha256.ToLowerInvariant()) { throw ('Integrity check failed for ' + $file.name + '.') }",
    '}',
    '$driverSource = Join-Path $stagingDirectory "aibridge.sys"',
    '$bridgeSource = Join-Path $stagingDirectory "roxy-kernel-bridge.exe"',
    '$bridgeRecord = @($manifest.files | Where-Object { $_.name -eq "roxy-kernel-bridge.exe" })',
    "if ($bridgeRecord.Count -ne 1 -or $bridgeRecord[0].sha256.ToLowerInvariant() -ne $expectedBridgeHash -or (Get-FileHash -Algorithm SHA256 -LiteralPath $bridgeSource).Hash.ToLowerInvariant() -ne $expectedBridgeHash) { throw 'Bridge executable hash mismatch.' }",
    '$certificateSource = Join-Path $stagingDirectory "aibridge-test.cer"',
    '$certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($certificateSource)',
    "if ($certificate.Thumbprint.ToLowerInvariant() -ne $expectedSignerThumbprint) { throw 'Certificate thumbprint mismatch.' }",
    '$signature = Get-AuthenticodeSignature -LiteralPath $driverSource',
    "if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint.ToLowerInvariant() -ne $expectedSignerThumbprint) { throw 'Driver signer mismatch.' }",
    `$serviceKey = ${powershellLiteral(`Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\${SERVICE_NAME}`)}`,
    '$service = Get-ItemProperty -LiteralPath $serviceKey -ErrorAction SilentlyContinue',
    'if ($service) {',
    `  $registeredPath = [Environment]::ExpandEnvironmentVariables([string]$service.ImagePath).Trim('"')`,
    "  if ($registeredPath.StartsWith('\\??\\')) { $registeredPath = $registeredPath.Substring(4) }",
    "  if ($registeredPath.StartsWith('\\\\?\\')) { $registeredPath = $registeredPath.Substring(4) }",
    "  if ([IO.Path]::GetFullPath($registeredPath) -ne [IO.Path]::GetFullPath($driverTarget)) { throw 'Refusing to replace an AIBridge service not owned by Roxy.' }",
    `  & sc.exe stop ${SERVICE_NAME} | Out-Null`,
    "  for ($attempt = 0; $attempt -lt 30 -and (Get-Service -Name ${SERVICE_NAME} -ErrorAction SilentlyContinue).Status -ne 'Stopped'; $attempt++) { Start-Sleep -Milliseconds 500 }",
    "  if ((Get-Service -Name ${SERVICE_NAME} -ErrorAction SilentlyContinue).Status -ne 'Stopped') { throw 'The AIBridge service did not stop.' }",
    '}',
    'Copy-Item -Force -LiteralPath $driverSource -Destination $driverTarget',
    'Copy-Item -Force -LiteralPath $bridgeSource -Destination $bridgeTarget',
    '$previousInstallManifest = if (Test-Path $installManifestPath) { Get-Content -Raw -LiteralPath $installManifestPath | ConvertFrom-Json } else { $null }',
    '$rootCertificateManagedByRoxy = [bool]$previousInstallManifest.rootCertificateManagedByRoxy -or -not (Test-Path ("Cert:\\LocalMachine\\Root\\" + $expectedSignerThumbprint))',
    '$publisherCertificateManagedByRoxy = [bool]$previousInstallManifest.publisherCertificateManagedByRoxy -or -not (Test-Path ("Cert:\\LocalMachine\\TrustedPublisher\\" + $expectedSignerThumbprint))',
    '@{ version = $expectedVersion; signerThumbprint = $expectedSignerThumbprint; rootCertificateManagedByRoxy = $rootCertificateManagedByRoxy; publisherCertificateManagedByRoxy = $publisherCertificateManagedByRoxy } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $installManifestPath',
    'try {',
    '  if ($rootCertificateManagedByRoxy) { Import-Certificate -FilePath $certificateSource -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null }',
    '  if ($publisherCertificateManagedByRoxy) { Import-Certificate -FilePath $certificateSource -CertStoreLocation Cert:\\LocalMachine\\TrustedPublisher | Out-Null }',
    '} catch {',
    '  if ($rootCertificateManagedByRoxy) { Remove-Item -Force ("Cert:\\LocalMachine\\Root\\" + $expectedSignerThumbprint) -ErrorAction SilentlyContinue }',
    '  if ($publisherCertificateManagedByRoxy) { Remove-Item -Force ("Cert:\\LocalMachine\\TrustedPublisher\\" + $expectedSignerThumbprint) -ErrorAction SilentlyContinue }',
    '  throw',
    '}',
    'if (-not $service) {',
    `  & sc.exe create ${SERVICE_NAME} 'type=' 'kernel' 'start=' 'demand' 'binPath=' $driverTarget | Out-Null`,
    '  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    '}',
    startDriver ? `& sc.exe start ${SERVICE_NAME} | Out-Null` : 'exit 0',
    startDriver ? 'exit $LASTEXITCODE' : '',
    '} finally { Remove-Item -Recurse -Force $stagingDirectory -ErrorAction SilentlyContinue }'
  ].join('; ')
}
function uninstallDriverScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$installManifestPath = ${powershellLiteral(INSTALL_MANIFEST_PATH)}`,
    `$serviceKey = ${powershellLiteral(`Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\${SERVICE_NAME}`)}`,
    '$service = Get-ItemProperty -LiteralPath $serviceKey -ErrorAction SilentlyContinue',
    'if ($service) {',
    `  $registeredPath = [Environment]::ExpandEnvironmentVariables([string]$service.ImagePath).Trim('"')`,
    "  if ($registeredPath.StartsWith('\\??\\')) { $registeredPath = $registeredPath.Substring(4) }",
    "  if ($registeredPath.StartsWith('\\\\?\\')) { $registeredPath = $registeredPath.Substring(4) }",
    `  if ([IO.Path]::GetFullPath($registeredPath) -ne [IO.Path]::GetFullPath(${powershellLiteral(DRIVER_PATH)})) { throw 'Refusing to remove an AIBridge service not owned by Roxy.' }`,
    `  & sc.exe stop ${SERVICE_NAME} | Out-Null`,
    '  Start-Sleep -Seconds 1',
    `  & sc.exe delete ${SERVICE_NAME} | Out-Null`,
    '  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1060) { exit $LASTEXITCODE }',
    '}',
    `Remove-Item -Force ${powershellLiteral(DRIVER_PATH)} -ErrorAction SilentlyContinue`,
    `Remove-Item -Force ${powershellLiteral(BRIDGE_PATH)} -ErrorAction SilentlyContinue`,
    '$installManifest = if (Test-Path $installManifestPath) { Get-Content -Raw -LiteralPath $installManifestPath | ConvertFrom-Json } else { $null }',
    `if ($installManifest.signerThumbprint -eq ${powershellLiteral(SIGNER_THUMBPRINT)} -and $installManifest.rootCertificateManagedByRoxy) { Remove-Item -Force ${powershellLiteral(`Cert:\LocalMachine\Root\${SIGNER_THUMBPRINT}`)} -ErrorAction SilentlyContinue }`,
    `if ($installManifest.signerThumbprint -eq ${powershellLiteral(SIGNER_THUMBPRINT)} -and $installManifest.publisherCertificateManagedByRoxy) { Remove-Item -Force ${powershellLiteral(`Cert:\LocalMachine\TrustedPublisher\${SIGNER_THUMBPRINT}`)} -ErrorAction SilentlyContinue }`,
    `if (Test-Path ${powershellLiteral(DRIVER_PATH)}) { throw 'The installed driver file could not be removed.' }`,
    `if (Test-Path ${powershellLiteral(BRIDGE_PATH)}) { throw 'The installed bridge file could not be removed.' }`,
    `if (Test-Path ${powershellLiteral(PRIVILEGED_INSTALL_DIR)}) { Remove-Item -Recurse -Force ${powershellLiteral(PRIVILEGED_INSTALL_DIR)} -ErrorAction SilentlyContinue }`
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
        [
          `$serviceKey = ${powershellLiteral(`Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\${SERVICE_NAME}`)}`,
          '$serviceConfig = Get-ItemProperty -LiteralPath $serviceKey -ErrorAction SilentlyContinue',
          'if (-not $serviceConfig) { 0; exit }',
          `$expectedPath = ${powershellLiteral(DRIVER_PATH)}`,
          `$registeredPath = [Environment]::ExpandEnvironmentVariables([string]$serviceConfig.ImagePath).Trim('"')`,
          "if ($registeredPath.StartsWith('\\??\\')) { $registeredPath = $registeredPath.Substring(4) }",
          "if ($registeredPath.StartsWith('\\\\?\\')) { $registeredPath = $registeredPath.Substring(4) }",
          'if ([IO.Path]::GetFullPath($registeredPath) -ne [IO.Path]::GetFullPath($expectedPath)) { 9; exit }',
          `$service = Get-Service -Name ${powershellLiteral(SERVICE_NAME)} -ErrorAction SilentlyContinue`,
          'if ($service) { [int]$service.Status } else { 0 }'
        ].join('; ')
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

async function setKernelAgentAccessImpl(enable: boolean): Promise<KernelInstallResult> {
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

  const serviceExists = driverState === 'running' || driverState === 'stopped'
  return {
    isWindows: true,
    installed: driverPath !== null && bridgePath !== null && serviceExists,
    hasArtifacts: driverPath !== null || bridgePath !== null || serviceExists,
    driverPath,
    testSigning,
    bridgePath,
    mcpRegistered,
    driverState
  }
}

async function fetchRelease(): Promise<Response> {
  try {
    const response = app.isReady() ? await electronNet.fetch(RELEASE_URL) : await fetch(RELEASE_URL)
    if (response.ok) return response
  } catch {
    // Fall through to Node's network stack for environments where Chromium is blocked.
  }
  return fetch(RELEASE_URL)
}

export async function setKernelAgentAccess(enable: boolean): Promise<KernelInstallResult> {
  return runMutation(() => setKernelAgentAccessImpl(enable))
}

async function downloadPinnedRelease(steps: string[]): Promise<void> {
  steps.push(`Downloading pinned Kernel Tools ${RELEASE_TAG}...`)
  await rm(ARCHIVE_PATH, { force: true })
  mkdirSync(INSTALL_DIR, { recursive: true })

  const response = await fetchRelease()
  if (!response.ok) throw new Error(`Kernel Tools download failed (${response.status}).`)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_RELEASE_BYTES) throw new Error('The Kernel Tools download is too large.')
  if (!response.body) throw new Error('The Kernel Tools download returned no body.')
  const archive = await open(ARCHIVE_PATH, 'wx')
  let downloadedBytes = 0
  try {
    for await (const chunk of response.body) {
      downloadedBytes += chunk.byteLength
      if (downloadedBytes > MAX_RELEASE_BYTES) {
        throw new Error('The Kernel Tools download is too large.')
      }
      await archive.write(chunk)
    }
  } finally {
    await archive.close()
  }
  if (downloadedBytes === 0) throw new Error('The Kernel Tools download has an invalid size.')
  if (sha256(ARCHIVE_PATH) !== RELEASE_SHA256) {
    throw new Error('The Kernel Tools download failed its pinned SHA-256 integrity check.')
  }

  steps.push(`Verified the pinned Kernel Tools ${RELEASE_TAG} archive.`)
}

async function installKernelToolsImpl(): Promise<KernelInstallResult> {
  if (!isSupportedPlatform()) {
    return { ok: false, error: 'Kernel tools require 64-bit x64 Windows.', steps: [] }
  }
  const steps: string[] = []
  let enabledTestSigning = false

  try {
    await removeKernelMcpServers()
    await downloadPinnedRelease(steps)

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
      installedDriverScript(testSigningWasEnabled)
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

export async function installKernelTools(): Promise<KernelInstallResult> {
  return runMutation(installKernelToolsImpl)
}

async function startKernelDriverImpl(): Promise<KernelInstallResult> {
  if (!isSupportedPlatform()) {
    return { ok: false, error: 'Kernel tools require 64-bit x64 Windows.', steps: [] }
  }
  const steps: string[] = []

  if (!existsSync(DRIVER_PATH) || !existsSync(BRIDGE_PATH)) {
    return { ok: false, error: 'Install kernel tools before starting the driver.', steps }
  }

  const state = await getDriverServiceState()
  if (state === 'unknown' || state === 'not-installed') {
    return { ok: false, error: 'The AIBridge service is missing or is not owned by Roxy.', steps }
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

export async function startKernelDriver(): Promise<KernelInstallResult> {
  return runMutation(startKernelDriverImpl)
}

async function toggleTestSigningImpl(enable: boolean): Promise<KernelInstallResult> {
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

export async function toggleTestSigning(enable: boolean): Promise<KernelInstallResult> {
  return runMutation(() => toggleTestSigningImpl(enable))
}

async function uninstallKernelToolsImpl(disableSigning: boolean): Promise<KernelInstallResult> {
  if (!isWindows()) return { ok: false, error: 'Kernel tools require Windows.', steps: [] }
  const steps: string[] = []

  try {
    await removeKernelMcpServers()
    steps.push('Agent access disabled.')

    if (
      existsSync(DRIVER_PATH) ||
      existsSync(BRIDGE_PATH) ||
      existsSync(INSTALL_MANIFEST_PATH) ||
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

export async function uninstallKernelTools(disableSigning: boolean): Promise<KernelInstallResult> {
  return runMutation(() => uninstallKernelToolsImpl(disableSigning))
}
