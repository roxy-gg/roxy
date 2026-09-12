import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CHANNELS } from '../src/shared/ipc'
import type { KernelStatus } from '../src/shared/kernel'

const nonWindowsStatus: KernelStatus = {
  isWindows: false,
  installed: false,
  hasArtifacts: false,
  driverPath: null,
  bridgePath: null,
  testSigning: false,
  mcpRegistered: false,
  driverState: 'not-installed'
}

assert.equal(CHANNELS.kernelStatus, 'kernel:status')
assert.equal(CHANNELS.kernelInstall, 'kernel:install')
assert.equal(CHANNELS.kernelStart, 'kernel:start')
assert.equal(CHANNELS.kernelSetAgentAccess, 'kernel:setAgentAccess')
assert.equal(CHANNELS.kernelUninstall, 'kernel:uninstall')
assert.equal(CHANNELS.kernelToggleTestSigning, 'kernel:toggleTestSigning')
assert.equal(nonWindowsStatus.isWindows, false)

const defaultLocale = JSON.parse(
  readFileSync(path.join(process.cwd(), 'src/renderer/src/locales/default.json'), 'utf8')
) as { settings?: { kernel?: Record<string, string> } }
const kernelStrings = defaultLocale.settings?.kernel
assert.ok(kernelStrings, 'settings.kernel locale section exists')
for (const key of [
  'heading',
  'title',
  'windowsOnly',
  'description',
  'install',
  'uninstall',
  'refresh',
  'disableTestSigning',
  'enableAgentAccess',
  'disableAgentAccess',
  'confirmEnableAgentAccessDescription'
]) {
  assert.ok(kernelStrings[key], `settings.kernel.${key} resolves`)
}

console.log('kernel shared contract OK')
