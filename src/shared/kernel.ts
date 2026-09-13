export interface KernelStatus {
  isWindows: boolean
  installed: boolean
  hasArtifacts: boolean
  driverPath: string | null
  testSigning: boolean
  bridgePath: string | null
  mcpRegistered: boolean
  driverState: 'not-installed' | 'stopped' | 'running' | 'unknown'
}

export interface KernelInstallResult {
  ok: boolean
  error?: string
  steps: string[]
}
