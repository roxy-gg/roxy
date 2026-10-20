const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
let server, win
const errors = []
const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
const click = async (selector) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait()
}
const until = async (code) => {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(`return ${code}`)) return
    await wait()
  }
  throw new Error(code)
}
app
  .whenReady()
  .then(async () => {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: {
        host: '127.0.0.1',
        port: 3107,
        strictPort: true,
        fs: {
          allow: [
            path.join(__dirname, '../..'),
            await fs.realpath(path.join(__dirname, '../../node_modules'))
          ]
        }
      }
    })
    await server.listen()
    win = new BrowserWindow({
      width: 1100,
      height: 900,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true }
    })
    win.webContents.on('console-message', (_event, level, text) => {
      if (level >= 3) errors.push(text)
    })
    await win.loadURL('http://127.0.0.1:3107/?appearance')
    await until(`!!document.querySelector('#settings-engineering')`)
    assert.equal(
      await evaluate(`return document.querySelector('#settings-engineering').textContent`),
      'Reverse Engineering Tools'
    )
    assert(
      await evaluate(`return !!document.querySelector('#settings-engineering .lucide-scan-eye')`)
    )
    const source = '/@fs/' + path.resolve(__dirname, '../../src').replaceAll('\\', '/')
    const icons = await evaluate(`
      const { toolIcon } = await import(${JSON.stringify(source + '/renderer/src/canvas/tool-card.ts')});
      const { drawIcon, iconPath } = await import(${JSON.stringify(source + '/renderer/src/canvas/icons.ts')});
      const { ENGINEERING_OPERATIONS, engineeringName } = await import(${JSON.stringify(source + '/shared/engineering-tools.ts')});
      const names = ['rea_tools', ...ENGINEERING_OPERATIONS.map(engineeringName)];
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 24;
      const context = canvas.getContext('2d');
      drawIcon(context, 'scanEye', 0, 0, 14, '#ffffff');
      return {
        native: names.every(name => toolIcon(name) === 'scanEye'),
        mcp: toolIcon('mcp__rea__open_binary'),
        shell: toolIcon('bash'),
        fallback: toolIcon('unknown_tool'),
        cached: iconPath('scanEye') === iconPath('scanEye'),
        painted: context.getImageData(0, 0, 24, 24).data.some((value, index) => index % 4 === 3 && value > 0)
      };
    `)
    assert.deepEqual(icons, {
      native: true,
      mcp: 'network',
      shell: 'terminal',
      fallback: 'wrench',
      cached: true,
      painted: true
    })
    await click('#settings-engineering')
    await until(`!!document.querySelector('[data-engineering-tools]')`)
    const main = '[data-engineering-control] [role="switch"]'
    const bulk = '[data-engineering-control] button'
    const preferences = () => evaluate('return (await window.roxy.engineering.state()).preferences')
    const setState = async (patch) => {
      await evaluate(`
        const { setEngineeringState } = await import('/AppearanceHarness.tsx');
        setEngineeringState(${JSON.stringify(patch)});
      `)
      await wait()
    }
    assert.equal(
      await evaluate(
        `return document.querySelectorAll('[data-engineering-tools] > section').length`
      ),
      1
    )
    assert.equal(
      await evaluate(
        `return document.querySelectorAll('[data-engineering-control] [role="switch"]').length`
      ),
      0
    )
    assert.equal(
      await evaluate(
        `return document.querySelector('[data-engineering-tools] input[type="checkbox"]')`
      ),
      null
    )
    assert.equal(
      await evaluate(`return document.querySelector(${JSON.stringify(bulk)}).textContent.trim()`),
      'Download and Install'
    )
    assert.equal(
      await evaluate(`return document.querySelector(${JSON.stringify(bulk)}).disabled`),
      false
    )
    assert.equal((await preferences()).enabled, false)
    assert.equal((await preferences()).guidance, false)
    // Failure and cancellation keep the install action, never silently opt in.
    await evaluate(`
      window.__engineeringInstall = window.roxy.engineering.installAll;
      window.roxy.engineering.installAll = async () => ({ ok: false, error: 'download' });
    `)
    await click(bulk)
    assert.equal((await preferences()).enabled, false)
    assert(
      await evaluate(`return !!document.querySelector('[data-engineering-tools] [role="alert"]')`)
    )
    await evaluate(`
      const { setEngineeringState } = await import('/AppearanceHarness.tsx');
      window.__engineeringCancel = window.roxy.engineering.cancel;
      window.roxy.engineering.installAll = () => new Promise(resolve => {
        setEngineeringState({ job: { id: 'rea', phase: 'downloading', received: 0, total: 100 } });
        window.roxy.engineering.cancel = async () => {
          setEngineeringState({ job: null });
          resolve({ ok: false, error: 'cancelled' });
        };
      });
    `)
    await click(bulk)
    assert.equal(
      await evaluate(`return document.querySelector(${JSON.stringify(bulk)}).disabled`),
      true
    )
    await click('[data-engineering-control] [role="status"] button')
    assert.equal((await preferences()).enabled, false)
    assert.equal((await preferences()).guidance, false)
    await evaluate(`
      window.roxy.engineering.installAll = window.__engineeringInstall;
      window.roxy.engineering.cancel = window.__engineeringCancel;
    `)
    // A single click installs and replaces the button with an already-on switch.
    await click(bulk)
    assert.equal(
      await evaluate(
        `return document.querySelector(${JSON.stringify(main)}).getAttribute('aria-checked')`
      ),
      'true'
    )
    assert.equal(
      await evaluate(
        `return document.querySelectorAll('[data-engineering-control] [role="switch"]').length`
      ),
      1
    )
    assert.equal((await preferences()).guidance, true)
    await click(main)
    assert.equal((await preferences()).enabled, false)
    assert.equal((await preferences()).guidance, false)
    assert.equal(
      (await evaluate('return await window.roxy.engineering.state()')).installed.length,
      6
    )
    // No install call is needed to re-enable dependencies already on disk.
    await evaluate(
      `window.roxy.engineering.installAll = async () => { throw new Error('Unexpected reinstall'); }`
    )
    await click(main)
    assert.equal((await preferences()).enabled, true)
    assert.equal((await preferences()).guidance, true)
    await click('[data-engineering-detail] > summary')
    assert.equal(
      await evaluate(`return document.querySelectorAll('[data-engineering-group]').length`),
      6
    )
    await click('[data-engineering-group="ghidra"] > details > summary')
    await click('[data-engineering-group="ghidra"] [aria-label="rea_analyze_function"]')
    await click('[aria-label="Enable JADX tools"]')
    await click(main)
    await click(main)
    assert((await preferences()).disabledCalls.includes('analyze_function'))
    assert(!(await preferences()).groups.includes('jadx'))
    assert.equal(
      await evaluate(
        `return document.querySelector('[aria-label="rea_analyze_function"]').getAttribute('aria-checked')`
      ),
      'false'
    )
    // Revisit: derive on/off from saved preference, never automatically enable.
    await click(main)
    await click('#settings-about')
    await click('#settings-engineering')
    assert.equal(
      await evaluate(
        `return document.querySelector(${JSON.stringify(main)}).getAttribute('aria-checked')`
      ),
      'false'
    )
    const all = ['rea', 'ghidra', 'jadx', 'adb', 'frida', 'wireshark']
    await setState({
      preferences: { enabled: false, guidance: false, groups: [], disabledCalls: [] }
    })
    await click(main)
    assert.deepEqual((await preferences()).groups, all)
    // Unsupported dependencies do not prevent a fully installed supported toolkit.
    await setState({
      unsupported: ['ghidra', 'wireshark'],
      installed: ['rea', 'jadx', 'adb', 'frida']
    })
    assert.equal(
      await evaluate(
        `return document.querySelector(${JSON.stringify(main)}).getAttribute('aria-checked')`
      ),
      'true'
    )
    await setState({ unsupported: [], installed: all })
    win.setSize(390, 850)
    await wait(250)
    assert.equal(await evaluate(`return document.documentElement.scrollWidth > innerWidth`), false)
    await fs.mkdir(path.join(__dirname, '../.out'), { recursive: true })
    await fs.writeFile(
      path.join(__dirname, '../.out/engineering-mobile.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    win.setSize(1100, 900)
    await evaluate(`document.querySelector('[data-engineering-tools]').scrollIntoView()`)
    await wait()
    await fs.writeFile(
      path.join(__dirname, '../.out/engineering-desktop.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    assert.deepEqual(errors, [])
    console.log(
      'ENGINEERING UI OK: native icons, one-click setup, auto-on, combined tools/prompt switch, retained dependency and detail choices, failure/cancel, unsupported families, 390px no overflow'
    )
  })
  .then(async () => {
    win?.destroy()
    await server?.close()
    app.exit(0)
  })
  .catch(async (error) => {
    console.error(error, errors)
    win?.destroy()
    await server?.close()
    app.exit(1)
  })
