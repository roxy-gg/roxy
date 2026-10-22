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
        port: 3117,
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
    await win.loadURL('http://127.0.0.1:3117/?appearance')
    await until(`!!document.querySelector('#settings-cheat')`)
    assert.equal(await evaluate(`return !!document.querySelector('#settings-anti-cheat')`), false)
    await click('#settings-cheat')
    await until(`!!document.querySelector('[data-cheat-control] [role="switch"]')`)
    assert(await evaluate(`return !!document.querySelector('#settings-cheat .lucide-scan-line')`))
    assert(
      await evaluate(`return !!document.querySelector('[data-cheat-control] .lucide-scan-line')`)
    )
    assert(
      await evaluate(`return !!document.querySelector('#settings-engineering .lucide-scan-eye')`)
    )
    const source = '/@fs/' + path.resolve(__dirname, '../../src').replaceAll('\\', '/')
    const icons = await evaluate(`
      const { toolIcon } = await import(${JSON.stringify(source + '/renderer/src/canvas/tool-card.ts')});
      const { drawIcon, iconPath } = await import(${JSON.stringify(source + '/renderer/src/canvas/icons.ts')});
      const { CHEAT_SCHEMAS } = await import(${JSON.stringify(source + '/shared/cheat.ts')});
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 24;
      const context = canvas.getContext('2d');
      drawIcon(context, 'scanLine', 0, 0, 24, '#ffffff');
      const actual = context.getImageData(0, 0, 24, 24).data;
      const expected = document.createElement('canvas');
      expected.width = expected.height = 24;
      const reference = expected.getContext('2d');
      reference.strokeStyle = '#ffffff';
      reference.lineWidth = 2;
      reference.lineCap = reference.lineJoin = 'round';
      const referencePath = new Path2D();
      document.querySelector('[data-cheat-control] .lucide-scan-line').querySelectorAll('path').forEach(path => referencePath.addPath(new Path2D(path.getAttribute('d'))));
      reference.stroke(referencePath);
      const pixels = reference.getImageData(0, 0, 24, 24).data;
      return {
        cheat: CHEAT_SCHEMAS.every(({ function: f }) => toolIcon(f.name) === 'scanLine'),
        reverse: toolIcon('rea_tools') === 'scanEye' && toolIcon('rea_open_binary') === 'scanEye',
        distinct: iconPath('scanLine') !== iconPath('scanEye'),
        cached: iconPath('scanLine') === iconPath('scanLine'),
        painted: actual.some((value, index) => index % 4 === 3 && value > 0),
        matchesHeader: actual.every((value, index) => value === pixels[index])
      };
    `)
    assert.deepEqual(icons, {
      cheat: true,
      reverse: true,
      distinct: true,
      cached: true,
      painted: true,
      matchesHeader: true
    })
    assert.equal(
      await evaluate(`return document.querySelector('#settings-cheat').textContent.trim()`),
      'Cheat Engineering Tools'
    )
    assert.equal(
      await evaluate(`return document.querySelector('[data-cheat-tools] h2').textContent`),
      'Cheat Engineering Tools'
    )
    const control = '[data-cheat-control] [role="switch"]'
    assert.equal(
      await evaluate(
        `return document.querySelectorAll('[data-cheat-tools] [role="switch"]').length`
      ),
      28
    )
    assert.equal(
      await evaluate(
        `return document.querySelector(${JSON.stringify(control)}).getAttribute('aria-checked')`
      ),
      'false'
    )
    assert.equal(
      await evaluate('return document.querySelectorAll("[data-cheat-call]").length'),
      27,
      'Full catalog stays inspectable while off'
    )
    assert.equal(
      await evaluate('return !!document.querySelector("[data-cheat-prompt] pre")'),
      false,
      'No injected prompt while off'
    )
    await click('[data-cheat-sources] > summary')
    await click('[data-cheat-source="reclass"] button:last-child')
    assert.equal(
      (await evaluate('return (await window.roxy.cheat.state()).preferences')).enabled,
      false
    )
    await click(control)
    const calls = await evaluate(
      `return [...document.querySelectorAll('[data-cheat-call] > div code')].map((node) => node.textContent)`
    )
    assert.equal(calls.length, 27)
    assert(calls.every((name) => name.startsWith('cheat_')))
    const prompt = () =>
      evaluate('return document.querySelector("[data-cheat-prompt] pre")?.textContent')
    const writeSwitch = '[data-cheat-call="cheat_write_memory"] [role="switch"]'
    await click(writeSwitch)
    assert.equal(
      await evaluate(
        `return document.querySelector(${JSON.stringify(writeSwitch)}).getAttribute('aria-checked')`
      ),
      'false'
    )
    assert(
      (
        await evaluate('return (await window.roxy.cheat.state()).preferences.disabledCalls')
      ).includes('cheat_write_memory')
    )
    assert(
      !(await prompt()).split('\n')[1].includes('cheat_write_memory'),
      'Prompt authoritative list matches selected calls'
    )
    await click('[data-cheat-call="cheat_read_memory"] summary')
    const definition = JSON.parse(
      await evaluate(
        'return document.querySelector("[data-cheat-call=cheat_read_memory] pre").textContent'
      )
    )
    assert.equal(definition.name, 'cheat_read_memory')
    assert(definition.parameters.properties.address)
    await click(control)
    assert.equal(await prompt(), undefined)
    await click(control)
    assert.equal(
      await evaluate(
        `return document.querySelector(${JSON.stringify(writeSwitch)}).getAttribute('aria-checked')`
      ),
      'false',
      'Master retains call selection'
    )
    await click(writeSwitch)
    await click('[data-cheat-catalog] > div:nth-of-type(2) button:last-child')
    assert.equal(await prompt(), undefined, 'All calls deselected means no injected prompt')
    await click('[data-cheat-catalog] > div:nth-of-type(2) button:first-child')
    assert((await prompt()).split('\n')[1].includes('cheat_write_memory'))
    assert.equal(await evaluate('return !!document.querySelector("[data-cheat-approvals]")'), false)
    assert.equal(await evaluate('return "approve" in window.roxy.cheat'), false)
    assert(
      (
        await evaluate('return document.querySelector("[data-cheat-prompt] pre").textContent')
      ).includes('No UI confirmation, approval ID or expiry is required')
    )
    await click('#settings-about')
    await click('#settings-cheat')
    assert.equal(
      await evaluate(
        `return document.querySelector(${JSON.stringify(control)}).getAttribute('aria-checked')`
      ),
      'true'
    )
    await fs.mkdir(path.join(__dirname, '../.out'), { recursive: true })
    await fs.writeFile(
      path.join(__dirname, '../.out/cheat-desktop.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    win.setSize(390, 850)
    await wait(250)
    assert.equal(await evaluate('return document.documentElement.scrollWidth > innerWidth'), false)
    await fs.writeFile(
      path.join(__dirname, '../.out/cheat-mobile.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await evaluate(
      `const { setCheatState } = await import('/AppearanceHarness.tsx'); setCheatState({ supported: false });`
    )
    await wait()
    assert.equal(
      await evaluate(`return document.querySelector(${JSON.stringify(control)}).disabled`),
      true
    )
    assert.deepEqual(errors, [])
    console.log(
      'CHEAT UI OK: master switch, 27 configurable direct calls, no approval panel/API, exact injected prompt, source download without enablement, retained state, unsupported platform, 390px layout'
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
