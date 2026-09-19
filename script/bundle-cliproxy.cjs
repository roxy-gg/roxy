const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const { promises: fs } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const REPO = 'router-for-me/CLIProxyAPI'
const API = `https://api.github.com/repos/${REPO}`

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assetName(version, platform, arch) {
  const osName = platform === 'win32' ? 'windows' : platform
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'amd64' : null
  if (!['win32', 'darwin', 'linux'].includes(platform) || !cpu) {
    throw new Error(`CLIProxyAPI has no bundled build mapping for ${platform}/${arch}.`)
  }
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'
  return `CLIProxyAPI_${version}_${osName}_${cpu}.${ext}`
}

function archName(arch) {
  // builder-util's Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
  if (arch === 1) return 'x64'
  if (arch === 3) return 'arm64'
  throw new Error(`CLIProxyAPI bundling does not support electron-builder architecture ${arch}.`)
}

async function fetchBytes(url, label) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'roxy-build'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000)
  })
  if (!response.ok) throw new Error(`Couldn't download ${label} (${response.status}).`)
  return Buffer.from(await response.arrayBuffer())
}

async function releaseMetadata() {
  const requested = process.env.CLIPROXY_VERSION?.replace(/^v/, '')
  const url = requested ? `${API}/releases/tags/v${requested}` : `${API}/releases/latest`
  const release = JSON.parse(
    (await fetchBytes(url, 'CLIProxyAPI release metadata')).toString('utf8')
  )
  const version = String(release.tag_name || '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`CLIProxyAPI returned an invalid release tag: ${release.tag_name}`)
  }
  return { release, version }
}

function checksumFor(body, asset) {
  for (const line of body.split('\n')) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/i)
    if (match && match[2].trim() === asset) return match[1].toLowerCase()
  }
  return null
}

async function findFile(root, wanted) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === wanted.toLowerCase()) return full
    if (entry.isDirectory()) {
      const nested = await findFile(full, wanted)
      if (nested) return nested
    }
  }
  return null
}

async function bundleCliProxy(context) {
  const platform = context.electronPlatformName
  if (platform === 'darwin' && context.arch === 4) {
    throw new Error(
      'CLIProxyAPI cannot be embedded into a universal macOS build; package x64 and arm64 separately.'
    )
  }
  const arch = archName(context.arch)
  const { release, version } = await releaseMetadata()
  const asset = assetName(version, platform, arch)
  const byName = new Map(release.assets.map((item) => [item.name, item.browser_download_url]))
  const archiveUrl = byName.get(asset)
  const checksumsUrl = byName.get('checksums.txt')
  if (!archiveUrl || !checksumsUrl) {
    throw new Error(`CLIProxyAPI v${version} does not publish ${asset} and checksums.txt.`)
  }

  console.log(`  - bundling CLIProxyAPI v${version} (${platform}/${arch})`)
  const [checksums, archive] = await Promise.all([
    fetchBytes(checksumsUrl, 'CLIProxyAPI checksums'),
    fetchBytes(archiveUrl, asset)
  ])
  const expectedArchiveSha256 = checksumFor(checksums.toString('utf8'), asset)
  const archiveSha256 = sha256(archive)
  if (!expectedArchiveSha256 || archiveSha256 !== expectedArchiveSha256) {
    throw new Error(
      `CLIProxyAPI integrity check failed for ${asset}: expected ${expectedArchiveSha256 || 'no published checksum'}, got ${archiveSha256}.`
    )
  }

  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-bundle-cliproxy-'))
  try {
    const archivePath = path.join(staging, asset)
    const extracted = path.join(staging, 'extracted')
    await fs.mkdir(extracted)
    await fs.writeFile(archivePath, archive)
    const tar =
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
    await execFileAsync(tar, ['-xf', archivePath, '-C', extracted])

    const binaryName = platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'
    const binary = await findFile(extracted, binaryName)
    if (!binary) throw new Error(`${asset} did not contain ${binaryName}.`)

    const resources = context.packager.getResourcesDir(context.appOutDir)
    const destination = path.join(resources, 'cliproxy')
    await fs.rm(destination, { recursive: true, force: true })
    await fs.mkdir(destination, { recursive: true })
    const bundledBinary = path.join(destination, binaryName)
    await fs.copyFile(binary, bundledBinary)
    if (platform !== 'win32') await fs.chmod(bundledBinary, 0o755)

    const license = await findFile(extracted, 'LICENSE')
    if (license) await fs.copyFile(license, path.join(destination, 'LICENSE'))

    // On macOS electron-builder signs every executable it finds during the later
    // signing phase. The manifest records this pristine upstream hash; runtime
    // integrity is still enforced by the enclosing Roxy code signature there.
    const binarySha256 = sha256(await fs.readFile(bundledBinary))
    await fs.writeFile(
      path.join(destination, 'manifest.json'),
      JSON.stringify(
        {
          version,
          platform,
          arch,
          binary: binaryName,
          binarySha256,
          asset,
          archiveSha256,
          source: `https://github.com/${REPO}/releases/tag/v${version}`
        },
        null,
        2
      ) + '\n'
    )
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

module.exports = bundleCliProxy
module.exports.default = bundleCliProxy
module.exports.assetName = assetName
module.exports.checksumFor = checksumFor
