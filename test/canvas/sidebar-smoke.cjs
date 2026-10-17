const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const { mkdtempSync } = require('node:fs')
app.setPath('userData', mkdtempSync(path.join(require('node:os').tmpdir(), 'roxy-sidebar-')))
let win, server
const errors = []
const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => win.webContents.executeJavaScript(code, true)
const row = (name) =>
  `[...document.querySelectorAll('li > .group')].find(el => el.querySelector('button > span')?.textContent === ${JSON.stringify(name)})`
const until = async (code) => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(code)) return
    await wait(50)
  }
  throw Error(`Timed out: ${code}`)
}
const move = async (name) => {
  win.focus()
  await evaluate(`${row(name)}.scrollIntoView({ block: 'nearest' })`)
  const point = await evaluate(`(() => {
    const box = ${row(name)}.getBoundingClientRect();
    return {x:Math.round(box.x + box.width / 2), y:Math.round(box.y + box.height / 2)};
  })()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await wait(300)
}
async function run() {
  if (!process.env.CANVAS_TEST_URL) {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { host: '127.0.0.1', port: 3105, strictPort: true }
    })
    await server.listen()
  }
  win = new BrowserWindow({
    width: 900,
    height: 1000,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await win.loadURL(`${process.env.CANVAS_TEST_URL ?? 'http://127.0.0.1:3105/'}?sidebar`)
  await until(`!!document.querySelector('[data-git-status]')`)
  for (const [name, states] of [
    ['Merged', ['merged']],
    ['Draft', ['pending']],
    ['Open', ['pending']],
    ['Dirty', ['local']],
    ['Clean', []],
    ['Closed', ['closed']],
    ['Regular', []],
    ['Shared checkout', []],
    ['Multi unknown', []],
    ['Generating', []]
  ]) {
    assert.deepEqual(
      await evaluate(
        `[...${row(name)}.querySelectorAll('[data-git-status]')].map(el => el.dataset.gitStatus)`
      ),
      states,
      name
    )
  }
  for (const count of [3, 5, 9, 12, 25]) {
    assert.deepEqual(
      await evaluate(
        `[...${row(`Multi ${count}`)}.querySelectorAll('[data-git-status]')].map(el => el.dataset.gitStatus)`
      ),
      Array.from({ length: count }, (_, i) => ['merged', 'pending', 'closed', 'local'][i % 4])
    )
    assert.ok(
      await evaluate(`(() => {
      const row = ${row(`Multi ${count}`)};
      const slot = row.lastElementChild.getBoundingClientRect();
      return [...row.querySelectorAll('[data-git-status]')].every(el => {
        const box=el.getBoundingClientRect();
        return box.left>=slot.left && box.right<=slot.right && box.top>=slot.top && box.bottom<=slot.bottom;
      });
    })()`),
      `${count} dots fit the action slot`
    )
    assert.ok(
      await evaluate(`(() => {
        const owner = ${row(`Multi ${count}`)};
        const slot = owner.lastElementChild.getBoundingClientRect();
        const dots = [...owner.querySelectorAll('[data-git-status]')].map(el => el.getBoundingClientRect());
        const rows = Map.groupBy(dots, box => Math.round(box.top * 10));
        return Math.abs((Math.min(...dots.map(box => box.top)) + Math.max(...dots.map(box => box.bottom))) / 2 - (slot.top + slot.height / 2)) < 0.1
          && [...rows.values()].every(boxes => Math.abs((boxes[0].left + boxes.at(-1).right) / 2 - (slot.left + slot.width / 2)) < 0.1)
          && dots.every(box => box.width <= 3 && Math.abs(box.width - box.height) < 0.1);
      })()`),
      `${count} small round dots have every row centered in the slot`
    )
  }
  for (const [name, color] of [
    ['Dirty', 'bg-text-muted'],
    ['Draft', 'bg-warning'],
    ['Open', 'bg-warning'],
    ['Merged', 'bg-success'],
    ['Closed', 'bg-danger']
  ]) {
    assert.ok(
      await evaluate(
        `${row(name)}.querySelector('[data-git-status]').classList.contains(${JSON.stringify(color)})`
      ),
      `${name} uses ${color}`
    )
  }
  assert.ok(
    await evaluate(`${row('Multi 3')}.querySelector('button').title.includes('repo-2: Draft #2')`),
    'tooltip preserves per-repo PR details'
  )
  assert.equal(
    await evaluate(`${row('Merged')}.innerText.includes('merged')`),
    false,
    'no inline PR label'
  )
  const before = await evaluate(
    `${row('Merged')}.querySelector('button').getBoundingClientRect().width`
  )
  await move('Merged')
  await until(
    `getComputedStyle(${row('Merged')}.querySelector('button[title="Delete session"]')).opacity === '1'`
  )
  assert.equal(
    await evaluate(`getComputedStyle(${row('Merged')}.querySelector('[role="img"]')).visibility`),
    'hidden'
  )
  assert.equal(
    await evaluate(
      `getComputedStyle(${row('Merged')}.querySelector('button[title="Delete session"]')).opacity`
    ),
    '1'
  )
  assert.equal(
    await evaluate(`${row('Merged')}.querySelector('button').getBoundingClientRect().width`),
    before,
    'hover causes no reflow'
  )
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 10 })
  await wait()
  assert.equal(
    await evaluate(`getComputedStyle(${row('Merged')}.querySelector('[role="img"]')).visibility`),
    'visible'
  )
  await evaluate(`${row('Merged')}.querySelector('button[title="Delete session"]').focus()`)
  await until(`getComputedStyle(document.activeElement).opacity === '1'`)
  assert.equal(
    await evaluate(`getComputedStyle(document.activeElement).opacity`),
    '1',
    'keyboard reveals delete'
  )
  await evaluate(`document.activeElement.blur()`)
  for (const name of ['Generating', 'Regular generating']) {
    const selector = `${row(name)}.querySelector('button[title="Stop this session"]')`
    const first = await evaluate(`${selector}.querySelector('span').textContent`)
    await until(`${selector}.querySelector('span').textContent !== ${JSON.stringify(first)}`)
    assert.equal(
      await evaluate(`!!${row(name)}.querySelector('button[title="Delete session"]')`),
      false
    )
  }
  await evaluate(`document.querySelector('button[title="Stop this session"]').click()`)
  await until(
    `${row('Generating')}.querySelector('[data-git-status]')?.dataset.gitStatus === 'merged'`
  )
  await evaluate(`${row('Merged')}.querySelector('button[title="Delete session"]').click()`)
  await until(`!${row('Merged')}`)
  win.setSize(390, 844)
  await wait()
  assert.ok(
    await evaluate(`(() => {
    const sidebar=document.querySelector('[data-sidebar-frame]');
    return sidebar.scrollWidth <= sidebar.clientWidth;
  })()`),
    'narrow window does not overflow'
  )
  assert.deepEqual(errors, [])
  const snapshot = () =>
    evaluate(`(() => {
    const rows = [...document.querySelectorAll('li > .group')];
    return rows.map(row => [row.querySelector('button > span')?.textContent,
      [...row.querySelectorAll('[data-git-status]')].map(dot => dot.dataset.gitStatus)]);
  })()`)
  const beforeRestart = await snapshot()
  const baseUrl = process.env.CANVAS_TEST_URL ?? 'http://127.0.0.1:3105/'
  await win.loadURL(`${baseUrl}?sidebar&restoreStatus`)
  await until(`!!document.querySelector('[data-git-status]')`)
  assert.deepEqual(
    (await snapshot()).filter(([name]) => beforeRestart.some(([old]) => old === name)),
    beforeRestart.map(([name, dots]) => [name, name === 'Generating' ? [] : dots]),
    'restart restores single and multi-repo dots without a poll'
  )
  const storeUrl =
    '/@fs/' + path.resolve(__dirname, '../../src/renderer/src/lib/store.ts').replaceAll('\\', '/')
  await evaluate(`(async () => {
    const { useRoxyStore: store } = await import(${JSON.stringify(storeUrl)});
    window.statusTest = { store, single: store.getState().gitStatus['/trees/Draft'],
      merged: store.getState().forgeStatus['/trees/Draft'],
      repos: store.getState().repoStatus['/trees/Multi 3'] };
    store.setState({ gitAvailable: true, projectRepos: {} });
    window.roxy.git ??= {};
    window.roxy.forge ??= {};
    window.roxy.git.status = async () => statusTest.single;
    window.roxy.forge.status = async () => ({ ...statusTest.merged, pull: null, refreshing: true });
    await store.getState().refreshGitStatus('Draft');
  })()`)
  assert.equal(
    await evaluate(`${row('Draft')}.querySelector('[data-git-status]').dataset.gitStatus`),
    'pending',
    'cold forge lookup retains cached PR'
  )
  await evaluate(`(async () => {
    window.roxy.forge.status = async () => { throw Error('timeout') };
    await statusTest.store.getState().refreshGitStatus('Draft');
    window.roxy.git.status = async () => ({ ...statusTest.single, isRepo: false, unavailable: true });
    await statusTest.store.getState().refreshGitStatus('Draft');
    window.roxy.git.statusMulti = async () => statusTest.repos.map(repo => ({ ...repo, isRepo: false, unavailable: true, forge: null }));
    await statusTest.store.getState().refreshGitStatus('Multi 3');
  })()`)
  assert.equal(
    await evaluate(`${row('Draft')}.querySelector('[data-git-status]').dataset.gitStatus`),
    'pending',
    'timeouts do not erase status'
  )
  assert.equal(
    await evaluate(`${row('Multi 3')}.querySelectorAll('[data-git-status]').length`),
    3,
    'unavailable repos retain individual dots'
  )
  await evaluate(`(async () => {
    window.roxy.git.status = async () => statusTest.single;
    window.roxy.forge.status = async () => ({ ...statusTest.merged, refreshing: false, error: null,
      pull: { ...statusTest.merged.pull, state: 'merged' },
      lifecycle: { ...statusTest.merged.lifecycle, phase: 'merged' } });
    await statusTest.store.getState().refreshGitStatus('Draft');
    window.roxy.git.statusMulti = async () => statusTest.repos.map((repo, i) => i === 1
      ? { ...repo, forge: { ...repo.forge, pull: null, error: { reason: 'network', message: 'timeout' } } }
      : { ...repo, forge: { ...repo.forge, refreshing: false,
        pull: { ...repo.forge.pull, state: 'draft' },
        lifecycle: { ...repo.forge.lifecycle, phase: 'draft' } } });
    await statusTest.store.getState().refreshGitStatus('Multi 3');
  })()`)
  assert.equal(
    await evaluate(`${row('Draft')}.querySelector('[data-git-status]').dataset.gitStatus`),
    'merged',
    'successful refresh replaces cached draft'
  )
  assert.deepEqual(
    await evaluate(
      `[...${row('Multi 3')}.querySelectorAll('[data-git-status]')].map(dot => dot.dataset.gitStatus)`
    ),
    ['pending', 'pending', 'pending'],
    'healthy repos update while one failed repo retains its PR'
  )
  await evaluate(`(async () => {
    window.roxy.git.status = async () => statusTest.single;
    window.roxy.forge.status = async () => ({ ...statusTest.merged, pull: null, refreshing: false,
      error: null, lifecycle: { ...statusTest.merged.lifecycle, phase: 'synced' } });
    await statusTest.store.getState().refreshGitStatus('Draft');
    window.roxy.git.statusMulti = async () => statusTest.repos.map(repo => ({ ...repo, dirty: false,
      forge: { ...repo.forge, pull: null, refreshing: false, error: null,
        lifecycle: { ...repo.forge.lifecycle, phase: 'synced' } } }));
    await statusTest.store.getState().refreshGitStatus('Multi 3');
  })()`)
  await until(
    `!${row('Draft')}.querySelector('[data-git-status]') && !${row('Multi 3')}.querySelector('[data-git-status]')`
  )
  await win.loadURL(`${baseUrl}?sidebar&restoreStatus`)
  await until(`!!${row('Draft')}`)
  assert.equal(
    await evaluate(`!!${row('Draft')}.querySelector('[data-git-status]')`),
    false,
    'successful clears persist too'
  )
  assert.equal(await evaluate(`!!${row('Multi 3')}.querySelector('[data-git-status]')`), false)
  assert.deepEqual(errors, [])
  console.log(
    'SIDEBAR OK: centered dots, hover/focus/delete, spinner, narrow layout, restart hydration, cold/failed polls, per-repo recovery, persisted authoritative clears'
  )
}
app
  .whenReady()
  .then(run)
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
