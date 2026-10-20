import { join } from 'node:path'

export interface EngineeringDownload {
  url: string
  sha256: string
  directory: string
  executable: string
  jar?: boolean
}
const NODE_HASHES: Record<string, string> = {
  'win32-x64': '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821',
  'darwin-x64': 'dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080',
  'darwin-arm64': 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',
  'linux-x64': '783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8',
  'linux-arm64': '6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508'
}
const JAVA_HASHES: Record<string, string> = {
  'win32-x64': '08cae782814f027f8b159d6b68823f0f87422eb475c1a0ea1abc7a4357aaf11f',
  'darwin-x64': '7484d5d4cdb02fc17a842ab86ddac2524a0365066659c46b2e258c64152379cd',
  'darwin-arm64': '01ca390455216ca27bdddf8cfad51aaedb4f90e1e23aad9bfd9e90caaa2c5f1b',
  'linux-x64': 'ea3b9bd464d6dd253e9a7accf59f7ccd2a36e4aa69640b7251e3370caef896a4',
  'linux-arm64': '357fee29fb0d5c079f6730db98b28942df13a6eed426f6c61cd4ad703ab27b9a'
}

// SHA-256 values are pinned from the vendor release manifests/assets. Never run
// an unverified archive or accept a renderer-supplied download URL.
export function engineeringDownload(
  id: string,
  platform = process.platform,
  arch = process.arch
): EngineeringDownload | null {
  const key = `${platform}-${arch}`
  if (id === 'node' && NODE_HASHES[key]) {
    const directory = `node-v24.18.0-${platform === 'win32' ? 'win' : platform}-${arch}`
    return {
      url: `https://nodejs.org/dist/v24.18.0/${directory}.${platform === 'win32' ? 'zip' : 'tar.gz'}`,
      sha256: NODE_HASHES[key],
      directory,
      executable: platform === 'win32' ? 'node.exe' : 'bin/node'
    }
  }
  if (id === 'java' && JAVA_HASHES[key]) {
    const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux'
    const cpu = arch === 'arm64' ? 'aarch64' : arch
    return {
      url: `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.10%2B7/OpenJDK21U-jdk_${cpu}_${os}_hotspot_21.0.10_7.${platform === 'win32' ? 'zip' : 'tar.gz'}`,
      sha256: JAVA_HASHES[key],
      directory: join('jdk-21.0.10+7', ...(platform === 'darwin' ? ['Contents', 'Home'] : [])),
      executable: platform === 'win32' ? 'bin/java.exe' : 'bin/java'
    }
  }
  if (id === 'ghidra')
    return {
      url: 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip',
      sha256: 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db',
      directory: 'ghidra_12.1.4_PUBLIC',
      executable: `Ghidra/Features/Decompiler/os/${platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'}_${arch === 'arm64' ? 'arm_64' : 'x86_64'}/decompile${platform === 'win32' ? '.exe' : ''}`
    }
  if (id === 'jadx')
    return {
      url: 'https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar',
      sha256: '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75',
      directory: '.',
      executable: 'jadx.jar',
      jar: true
    }
  if (id === 'adb' && arch === 'x64') {
    const os = platform === 'win32' ? 'win' : platform
    const hashes: Record<string, string> = {
      win: '45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99',
      linux: 'd230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1',
      darwin: 'ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d'
    }
    if (hashes[os])
      return {
        url: `https://dl.google.com/android/repository/platform-tools_r37.0.1-${os}.zip`,
        sha256: hashes[os],
        directory: 'platform-tools',
        executable: platform === 'win32' ? 'adb.exe' : 'adb'
      }
  }
  return null
}
