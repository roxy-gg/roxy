const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roxy-theme-'))
app.setPath('userData', temp)
let win, server
const errors = []
const moduleUrl = (file) => '/@fs/' + path.resolve(file).replaceAll('\\', '/')
const evaluate = (body) => win.webContents.executeJavaScript(`(async () => { ${body} })()`)

app.whenReady().then(async () => {
  try {
    server = await (
      await import('vite')
    ).createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { host: '127.0.0.1', port: 3100, strictPort: true }
    })
    await server.listen()
    win = new BrowserWindow({
      width: 1280,
      height: 850,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) errors.push(message)
    })
    await win.loadURL('http://127.0.0.1:3100/')
    await evaluate(`
      window.sourceThemes = await import(${JSON.stringify(moduleUrl('src/shared/theme.ts'))});
      window.themeApi = await import(${JSON.stringify(moduleUrl('src/renderer/src/lib/theme.ts'))});
      window.canvasTheme = await import(${JSON.stringify(moduleUrl('src/renderer/src/canvas/theme.ts'))});
      window.paintApi = await import(${JSON.stringify(moduleUrl('src/renderer/src/canvas/paint.ts'))});
      (await import(${JSON.stringify(moduleUrl('src/renderer/src/lib/squircle.ts'))})).installSquircle();
      const sample = document.createElement('div'); sample.id = 'theme-probe';
      sample.className = 'sq-frame sq-lg sq-ring sq-fill-surface-2 edge rounded-lg border bg-surface-2';
      sample.style.cssText = 'position:fixed;top:80px;right:20px;width:200px;height:70px';
      sample.textContent = 'Theme geometry'; document.body.append(sample);
    `)
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`return document.documentElement.hasAttribute('data-squircle')`)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(await evaluate(`return document.documentElement.hasAttribute('data-squircle')`))
    let previousEpoch = 0
    for (const [id, bg, radius, exponent] of [
      ['claude-code-dark', '#151515', 7, 2],
      ['claude-code-light', '#fcfcfb', 7, 2],
      ['codex-dark', '#181818', 10, 2 ** 1.5],
      ['codex-light', '#ffffff', 10, 2 ** 1.5],
      ['tokyo-0300', '#000102', 8, 4],
      ['orion-cyber', '#141414', 8, 4],
      ['roxy-dark', '#0a0a0a', 8, 4]
    ]) {
      const result = await evaluate(`
        const file = sourceThemes.getBuiltInTheme(${JSON.stringify(id)});
        themeApi.applyTheme(sourceThemes.resolveTheme(file));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const theme = canvasTheme.readTheme();
        const styles = getComputedStyle(document.querySelector('#theme-probe'));
        const points = [];
        const path = { rect:(x,y)=>points.push([x,y]), moveTo:(x,y)=>points.push([x,y]), lineTo:()=>{}, closePath:()=>{} };
        paintApi.squirclePath(path, 0, 0, 100, 100, 8, theme.corners);
        return { bg:theme.palette.bg, corners:theme.corners, epoch:theme.epoch,
          pathRadius:points[0][0], exponent:getComputedStyle(document.documentElement).getPropertyValue('--sq-exponent').trim(),
          edge:theme.edge, mask:styles.backgroundImage, domRadius:parseFloat(styles.borderRadius),
          sans:getComputedStyle(document.documentElement).getPropertyValue('--font-sans') };
      `)
      assert.equal(result.bg, bg, id + ' source background')
      assert.equal(result.corners.radii[8], radius, id + ' canvas radius')
      if (id === 'orion-cyber') {
        assert.equal(result.corners.scale, 0, 'Orion Cyber uses sharp canvas corners')
        assert.equal(result.domRadius, 0, 'Orion Cyber uses sharp DOM corners')
        assert.ok(result.sans.includes('Share Tech Mono'), 'Orion Cyber uses monospace UI')
      }
      assert.ok(Math.abs(result.corners.exponent - exponent) < 0.00001, id + ' exponent')
      assert.ok(
        Math.abs(result.pathRadius - radius * result.corners.scale) < 0.00001,
        id + ' painted radius'
      )
      assert.ok(result.epoch > previousEpoch, id + ' invalidates canvas caches')
      assert.ok(result.mask.includes('squircle-box'), id + ' keeps real painted borders')
      assert.ok(
        Math.abs(
          result.domRadius -
            radius *
              result.corners.scale *
              (id.startsWith('claude') ? 1 : id.startsWith('codex') ? 0.7420655675294083 : 0.543)
        ) < 0.001,
        id + ' DOM clipping follows the source curve'
      )
      assert.ok(
        id.startsWith('roxy') ? result.sans.includes('Geist') : !result.sans.includes('Geist'),
        id + ' font reset'
      )
      previousEpoch = result.epoch
      const dir = path.resolve('test/.out/theme-previews')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, id + '.png'), (await win.webContents.capturePage()).toPNG())
      console.log('OK', id, result.corners, result.sans)
    }
    assert.ok(
      await evaluate(`
      const before = canvasTheme.readTheme();
      document.documentElement.style.setProperty('--sq-exponent','2');
      document.documentElement.style.setProperty('--radius-lg','calc(0.5rem + 2px)');
      const after = canvasTheme.readTheme();
      document.documentElement.style.removeProperty('--sq-exponent');
      document.documentElement.style.removeProperty('--radius-lg');
      themeApi.clearTheme();
      return after.epoch > before.epoch && after.corners.radii[8] === 10 && !document.documentElement.style.getPropertyValue('--radius-lg') &&
        !document.documentElement.style.getPropertyValue('--font-sans');
    `),
      'geometry-only changes invalidate canvas and clearTheme restores defaults'
    )
    assert.deepEqual(errors, [])
    console.log('THEME UI OK: fonts, palette, DOM worklet, canvas geometry, switching and cleanup')
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    win?.destroy()
    await server?.close()
    app.quit()
    try {
      fs.rmSync(temp, { recursive: true, force: true })
    } catch {
      /* Windows may retain profile locks until exit. */
    }
  }
})
