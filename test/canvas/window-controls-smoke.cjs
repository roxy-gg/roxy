const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roxy-window-controls-'))
app.setPath('userData', temp)
const wait = () => new Promise((resolve) => setTimeout(resolve, 80))
let win, server
const errors = []

app.whenReady().then(async () => {
  let failed = false
  try {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: {
        host: '127.0.0.1',
        port: Number(process.env.ROXY_TEST_PORT || 3107),
        strictPort: true,
        fs: { allow: [path.resolve('.'), fs.realpathSync('node_modules')] }
      }
    })
    await server.listen()
    win = new BrowserWindow({
      width: 1100,
      height: 720,
      show: true,
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 16, y: 17 } }
        : { titleBarOverlay: { height: 48 } }),
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3 && !message.includes('Failed to load resource')) errors.push(message)
    })
    await win.loadURL(`${server.resolvedUrls.local[0]}providers.html`)
    const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`)
    const resize = async (width, height) => {
      win.setContentSize(width, height)
      for (let i = 0; i < 100; i++) {
        await wait()
        if (await evaluate(`return innerWidth === ${width} && innerHeight === ${height}`)) {
          await evaluate(`await new Promise(requestAnimationFrame)`)
          return
        }
      }
      throw new Error(`Resize timed out: ${width}x${height}`)
    }
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`return !!document.querySelector('#settings-search')`)) break
      await wait()
    }
    for (const platform of ['darwin', 'win32', 'linux']) {
      await evaluate(`document.documentElement.dataset.platform = '${platform}'`)
      for (const [width, height] of [
        [1100, 720],
        [760, 480],
        [390, 720]
      ]) {
        await resize(width, height)
        const layout = await evaluate(`
          const header = document.querySelector('.page-sidebar-header');
          const back = header.querySelector('button').getBoundingClientRect();
          const search = document.querySelector('#settings-search').getBoundingClientRect();
          return {
            left: back.left,
            top: back.top,
            bottom: back.bottom,
            searchTop: search.top,
            headerHeight: header.getBoundingClientRect().height,
            overflow: document.documentElement.scrollWidth > innerWidth
          };
        `)
        assert.equal(layout.left, 12, `${platform} ${width}: Back stays aligned with sidebar`)
        assert.equal(layout.headerHeight, platform === 'darwin' ? 104 : 56)
        assert(layout.top >= (platform === 'darwin' ? 48 : 0))
        assert(layout.searchTop >= layout.bottom, 'search stays below Back')
        assert(!layout.overflow, `${platform} ${width}: no page overflow`)
      }
    }

    // Mount the production browser chrome with enough tabs to force horizontal scrolling.
    const renderer = path.resolve('src/renderer/src').replaceAll('\\', '/')
    await evaluate(`
      document.querySelector('#root').style.display = 'none';
      const host = document.createElement('div');
      document.body.append(host);
      let newTabs = 0;
      window.testNewTabs = () => newTabs;
      Object.assign(window.roxy.browser, {
        setChromeHeight: async () => {},
        getProxy: async () => ({enabled: false}),
        onProxyChanged: () => () => {},
        onState: () => () => {},
        onTabs: (listener) => {
          queueMicrotask(() => listener(Array.from({length: 30}, (_, index) => ({
            id: String(index), title: 'Tab ' + index, url: 'about:blank', active: index === 0
          }))));
          return () => {};
        },
        newTab: async () => { newTabs++ }
      });
      const {default: React} = await import('/@fs/${path.resolve('node_modules/.vite/deps/react.js')}');
      const {default: ReactDOM} = await import('/@fs/${path.resolve('node_modules/.vite/deps/react-dom_client.js')}');
      const {BrowserChrome} = await import('/@fs/${renderer}/browser/BrowserChrome.tsx');
      ReactDOM.createRoot(host).render(React.createElement(BrowserChrome));
    `)
    await wait()
    for (const platform of ['darwin', 'win32', 'linux']) {
      await evaluate(`document.documentElement.dataset.platform = '${platform}'`)
      for (const width of [390, 760, 1100]) {
        await resize(width, 720)
        for (const end of [false, true]) {
          const layout = await evaluate(`
            const strip = document.querySelector('.reserve-controls-left');
            const scroller = strip.firstElementChild;
            scroller.scrollLeft = ${end} ? scroller.scrollWidth : 0;
            await new Promise(requestAnimationFrame);
            const rect = scroller.getBoundingClientRect();
            const left = document.elementFromPoint(20, 20);
            const right = document.elementFromPoint(innerWidth - 20, 20);
            return {
              left: rect.left, right: rect.right,
              stripScroll: strip.scrollLeft,
              scroll: scroller.scrollLeft,
              leftCovered: scroller.contains(left),
              rightCovered: scroller.contains(right)
            };
          `)
          assert.equal(layout.left, platform === 'darwin' ? 80 : 8)
          assert.equal(layout.right, width - (platform === 'darwin' ? 8 : 144))
          assert.equal(layout.stripScroll, 0, 'native-control reservation never scrolls')
          if (end) assert(layout.scroll > 0, 'tabs can still scroll')
          if (platform === 'darwin') assert(!layout.leftCovered, 'tabs cannot enter traffic lights')
          else assert(!layout.rightCovered, 'tabs cannot enter the control overlay')
        }
      }
    }
    await evaluate(`document.querySelector('button[title="New tab"]').click()`)
    assert.equal(await evaluate(`return window.testNewTabs()`), 1)
    assert.deepEqual(errors, [])
    console.log(
      'Window controls UI: aligned Back, safe macOS row, narrow layouts and fixed tab-scroll reservations passed on all three platforms'
    )
  } catch (error) {
    console.error(error)
    failed = true
  } finally {
    win?.destroy()
    await server?.close()
    fs.rmSync(temp, { recursive: true, force: true })
    app.exit(failed ? 1 : 0)
  }
})
