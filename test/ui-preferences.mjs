/** Renderer preferences regression smoke; real components, isolated hooks and bridge. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync, transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
const storage = new Map()
const localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value)
}
const key = 'roxy.quota.order.v1'
const quotasModule = { exports: {} }
new Function(
  'module',
  'exports',
  buildSync({
    entryPoints: ['src/shared/quota.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false
  }).outputFiles[0].text
)(quotasModule, quotasModule.exports)
const provider = { id: 'a', seedId: 'claude-subscription', name: 'Claude', enabled: true }
const sibling = { ...provider, id: 'b' }
const bucket = (id, label, remaining, family) => ({
  id,
  label,
  remaining,
  ...(family ? { family } : {})
})
const weekly = bucket('seven_day', 'Weekly', 2)
const five = bucket('five_hour', '5-hour', 91)
const sonnet = bucket('seven_day_sonnet', 'Weekly Sonnet', 10, 'sonnet')
const opus = bucket('seven_day_opus', 'Weekly Opus', 20, 'opus')
const quota = (id, buckets) => ({ connectionId: id, upstream: 'claude', buckets })
const state = {
  providers: [provider, sibling],
  quotas: {
    a: quota('a', [five, weekly, sonnet, opus]),
    b: quota('b', [bucket('five_hour', '5-hour', 1), bucket('seven_day', 'Weekly', 80)])
  },
  quotaLoading: {},
  modelCatalog: {},
  settings: {},
  ensureModels: () => {},
  refreshQuota: () => {}
}

let current
const hooks = {
  useState(initial) {
    const index = current.index++
    const context = current
    if (!(index in context.values))
      context.values[index] = typeof initial === 'function' ? initial() : initial
    return [
      context.values[index],
      (next) => {
        context.values[index] = typeof next === 'function' ? next(context.values[index]) : next
      }
    ]
  },
  useRef(initial) {
    const index = current.index++
    return (current.values[index] ??= { current: initial })
  },
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useId: () => 'test-id',
  useLayoutEffect: () => {},
  useEffect: (effect) => current.effects.push(effect)
}
const windowEvents = new Map()
const window = {
  addEventListener: (name, callback) => windowEvents.set(name, callback),
  removeEventListener: (name) => windowEvents.delete(name)
}
const document = { querySelector: () => null, activeElement: null }
function load(path, extra = '') {
  const source = readFileSync(path, 'utf8') + extra
  const module = { exports: {} }
  const dependencies = {
    react: hooks,
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    '@shared/quota': quotasModule.exports,
    '@shared/background': { backgroundOpacity: () => 0.3 },
    '../lib/background': {
      useBackground: () => ({ rendered: null, settings: { sidebarStyle: 'default' } })
    },
    './BackgroundFrame': { BackgroundFrame: () => null },
    './ChatBackground': { ChatBackground: () => null },
    '@shared/cliproxy': {
      upstreamFor: (seed) => {
        const upstream = {
          'claude-subscription': 'claude',
          'gemini-subscription': 'antigravity',
          'codex-subscription': 'codex'
        }[seed]
        return upstream ? { upstream, accountLabel: upstream } : undefined
      }
    },
    '../lib/store': { useRoxyStore: (selector) => selector(state) },
    '../lib/api': { api: {} },
    './ContextMenu': {
      ContextMenuSurface: () => null,
      ContextMenuRow: () => null,
      ContextMenuSeparator: () => null,
      CONTEXT_ROW_H: 30,
      CONTEXT_SEPARATOR_H: 5,
      CONTEXT_MENU_PAD: 8
    },
    './BotAvatar': { BotAvatar: () => null },
    './SidebarFrame': { SidebarFrame: () => null, SidebarNavItem: () => null },
    './ui': { Button: () => null },
    '../lib/cn': { cn: (...parts) => parts.filter(Boolean).join(' ') }
  }
  new Function(
    'require',
    'module',
    'exports',
    'localStorage',
    'window',
    'document',
    transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code
  )(
    (name) => dependencies[name] ?? require(name),
    module,
    module.exports,
    localStorage,
    window,
    document
  )
  return module.exports
}
function render(Component, props, context = { values: [], effects: [] }) {
  current = context
  current.index = 0
  current.effects = []
  return { tree: Component(props), context }
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
const find = (tree, type) => nodes(tree).find((node) => node.type === type)
const quotaUI = load(
  'src/renderer/src/components/QuotaMeter.tsx',
  '\nexport { BucketList, BucketRow, Meter, applyOrder, loadOrder }'
)
const pageUI = load('src/renderer/src/components/PageShell.tsx')
const botsUI = load('src/renderer/src/components/BotsSection.tsx')
globalThis.getComputedStyle = () => ({ direction: 'ltr' })
state.bots = ['alpha', 'beta', 'gamma'].map((id) => ({ id, username: id, chatId: 'chat-' + id }))
state.runningAutomation = {}
const botMoves = []
const botSelections = []
state.reorderBots = async (ids) => botMoves.push(ids)
state.selectChat = async (id) => botSelections.push(id)
const botButton = (tree, id) =>
  nodes(tree).find((node) => node.type === 'button' && node.props['aria-label'] === '@' + id)
for (const rail of [false, true]) {
  let strip = render(botsUI.BotsSection, { rail })
  const alpha = botButton(strip.tree, 'alpha')
  assert.equal(alpha.props.draggable, true)
  alpha.props.onDragStart({ dataTransfer: { setData() {} } })
  strip = render(botsUI.BotsSection, { rail }, strip.context)
  const beta = botButton(strip.tree, 'beta')
  beta.props.onDragOver({
    preventDefault() {},
    dataTransfer: {},
    clientX: 75,
    clientY: 75,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }
  })
  strip = render(botsUI.BotsSection, { rail }, strip.context)
  botButton(strip.tree, 'beta').props.onDrop({ preventDefault() {} })
  assert.deepEqual(botMoves.at(-1), ['beta', 'alpha', 'gamma'])
  strip = render(botsUI.BotsSection, { rail }, strip.context)
  botButton(strip.tree, 'alpha').props.onClick()
  assert.equal(botSelections.length, 0, 'drop must not open a chat')
  botButton(strip.tree, 'alpha').props.onKeyDown({ key: 'Enter' })
  botButton(strip.tree, 'alpha').props.onMouseDown()
  botButton(strip.tree, 'alpha').props.onClick()
  assert.equal(botSelections.pop(), 'chat-alpha')
  botButton(strip.tree, 'alpha').props.onKeyDown({
    key: 'ArrowRight',
    shiftKey: true,
    preventDefault() {},
    currentTarget: {}
  })
  assert.deepEqual(botMoves.at(-1), ['beta', 'alpha', 'gamma'])
}
globalThis.getComputedStyle = () => ({ direction: 'rtl' })
const rtlStrip = render(botsUI.BotsSection, {})
botButton(rtlStrip.tree, 'gamma').props.onKeyDown({
  key: 'ArrowRight',
  shiftKey: true,
  preventDefault() {},
  currentTarget: {}
})
assert.deepEqual(botMoves.at(-1), ['alpha', 'gamma', 'beta'])
delete globalThis.getComputedStyle

for (const raw of ['invalid', '[]', 'null', '{"claude":["five_hour",null,1,"five_hour"]}']) {
  storage.set(key, raw)
  const loaded = quotaUI.loadOrder()
  assert.deepEqual(loaded.claude ?? [], raw.startsWith('{') ? ['five_hour'] : [])
}
storage.set(
  key,
  JSON.stringify({ claude: ['removed-model', 'seven_day'], codex: ['primary', 'secondary'] })
)
const props = { provider, model: 'claude-sonnet-5-5' }
let mounted = render(quotaUI.QuotaMeter, props)
mounted.context.values[1] = state.quotas
find(mounted.tree, 'button').props.onClick()
mounted = render(quotaUI.QuotaMeter, props, mounted.context)
const limits = find(mounted.tree, quotaUI.BucketList)
assert.equal(typeof limits.props.onReorder, 'function')
limits.props.onReorder(['five_hour', 'seven_day_sonnet', 'seven_day'])
mounted = render(quotaUI.QuotaMeter, props, mounted.context)
assert.equal(find(mounted.tree, quotaUI.Meter).props.value, 91)
assert.equal(find(mounted.tree, quotaUI.Meter).props.status, 2)
assert.ok(nodes(mounted.tree).some((node) => node.props?.children === 'quota.pillHint'))
assert.equal(nodes(mounted.tree).filter((node) => node.type === quotaUI.BucketList).length, 2)
assert.ok(
  nodes(mounted.tree).some(
    (node) => node.type === quotaUI.BucketList && node.props.buckets[0]?.id === 'seven_day_opus'
  )
)
const saved = JSON.parse(storage.get(key))
assert.deepEqual(saved.claude, ['five_hour', 'seven_day_sonnet', 'seven_day'])
assert.deepEqual(saved.codex, ['primary', 'secondary'])
const reopened = render(quotaUI.QuotaMeter, props)
reopened.context.values[1] = state.quotas
assert.equal(
  find(render(quotaUI.QuotaMeter, props, reopened.context).tree, quotaUI.Meter).props.value,
  91
)
const storageSet = localStorage.setItem
localStorage.setItem = () => {
  throw new Error('storage blocked')
}
limits.props.onReorder(['five_hour', 'seven_day', 'seven_day_sonnet'])
mounted = render(quotaUI.QuotaMeter, props, mounted.context)
assert.equal(find(mounted.tree, quotaUI.Meter).props.value, 91)
localStorage.setItem = storageSet
find(mounted.tree, 'select').props.onChange({ target: { value: 'b' } })
mounted = render(quotaUI.QuotaMeter, props, mounted.context)
const siblingLimits = find(mounted.tree, quotaUI.BucketList)
assert.equal(typeof siblingLimits.props.onReorder, 'function')
assert.ok(find(render(quotaUI.BucketList, siblingLimits.props).tree, quotaUI.BucketRow).props.grip)
assert.ok(!nodes(mounted.tree).some((node) => node.props?.children === 'quota.pillHint'))
assert.equal(find(mounted.tree, quotaUI.Meter).props.value, 91)
siblingLimits.props.onReorder(['seven_day', 'five_hour'])
mounted = render(quotaUI.QuotaMeter, props, mounted.context)
assert.equal(find(mounted.tree, quotaUI.Meter).props.value, 2)
assert.deepEqual(JSON.parse(storage.get(key)).claude, ['seven_day', 'five_hour'])
assert.deepEqual(
  quotaUI.applyOrder([weekly, five], []).map((b) => b.id),
  ['seven_day', 'five_hour']
)
assert.deepEqual(
  quotaUI.applyOrder([weekly, five], ['unknown', 'five_hour']).map((b) => b.id),
  ['five_hour', 'seven_day']
)
const meter = render(quotaUI.Meter, { value: 91, status: 2 }).tree
assert.ok(nodes(meter).some((node) => node.props?.className?.includes('bg-danger')))
const hidden = render(quotaUI.BucketRow, { bucket: weekly, now: 0 }).tree
assert.ok(nodes(hidden).some((node) => node.props?.className?.includes('invisible h-9 w-5')))

const moves = []
let list = render(quotaUI.BucketList, {
  buckets: [weekly, five],
  now: 0,
  onReorder: (ids) => moves.push(ids)
})
const row = find(list.tree, quotaUI.BucketRow)
const grip = row.props.grip
assert.equal(grip.type, 'button')
assert.equal(grip.props['aria-haspopup'], 'menu')
grip.props.onKeyDown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} })
assert.deepEqual(moves[0], ['five_hour', 'seven_day'])
grip.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) } })
list = render(
  quotaUI.BucketList,
  { buckets: [weekly, five], now: 0, onReorder: (ids) => moves.push(ids) },
  list.context
)
const menu = nodes(list.tree).find((node) => node.props?.role === 'menu')
assert.ok(menu)
const actions = nodes(menu).filter((node) => node.props?.role === 'menuitem')
assert.equal(actions[0].props.disabled, true)
actions[1].props.onSelect()
assert.deepEqual(moves[1], ['five_hour', 'seven_day'])
let dragging = render(quotaUI.BucketList, {
  buckets: [weekly, five],
  now: 0,
  onReorder: (ids) => moves.push(ids)
})
find(dragging.tree, quotaUI.BucketRow).props.grip.props.onDragStart({
  dataTransfer: { setData() {} }
})
dragging = render(
  quotaUI.BucketList,
  { buckets: [weekly, five], now: 0, onReorder: (ids) => moves.push(ids) },
  dragging.context
)
const target = nodes(dragging.tree).filter((node) => node.props?.onDragOver)[1]
target.props.onDragOver({
  preventDefault() {},
  clientY: 75,
  currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) }
})
dragging = render(
  quotaUI.BucketList,
  { buckets: [weekly, five], now: 0, onReorder: (ids) => moves.push(ids) },
  dragging.context
)
nodes(dragging.tree)
  .filter((node) => node.props?.onDrop)[1]
  .props.onDrop({ preventDefault() {} })
assert.deepEqual(moves[2], ['five_hour', 'seven_day'])
const readOnly = render(quotaUI.BucketList, { buckets: [weekly, five], now: 0 })
assert.equal(find(readOnly.tree, quotaUI.BucketRow).props.grip, undefined)
const single = render(quotaUI.BucketList, { buckets: [weekly], now: 0, onReorder() {} })
assert.equal(find(single.tree, quotaUI.BucketRow).props.grip, undefined)

// Every allowance is reorderable, including when browsing another provider.
const gemini = { ...provider, id: 'google', seedId: 'gemini-subscription' }
const copilot = { ...provider, id: 'github', seedId: 'github-copilot' }
state.providers.push(gemini, copilot)
const modelBucket = (id, remaining) => ({ ...bucket(id, id, remaining), models: [id] })
state.quotas.google = {
  connectionId: 'google',
  upstream: 'antigravity',
  buckets: [modelBucket('gemini-pro', 75), modelBucket('gemini-flash', 10)]
}
state.quotas.github = {
  connectionId: 'github',
  upstream: 'copilot',
  buckets: [bucket('premium', 'Premium requests', 60), bucket('completions', 'Completions', 5)]
}
for (const [account, model, ids] of [
  [gemini, 'gemini-pro', ['gemini-flash', 'gemini-pro']],
  [copilot, 'paid-model', ['completions', 'premium']]
]) {
  const activeProps = { provider: account, model }
  let view = render(quotaUI.QuotaMeter, activeProps)
  view.context.values[1] = state.quotas
  find(view.tree, 'button').props.onClick()
  view = render(quotaUI.QuotaMeter, activeProps, view.context)
  const all = nodes(view.tree).filter((node) => node.type === quotaUI.BucketList)
  assert.equal(all.length, 1)
  assert.equal(all[0].props.buckets.length, 2)
  const rows = nodes(render(quotaUI.BucketList, all[0].props).tree).filter(
    (node) => node.type === quotaUI.BucketRow
  )
  assert.ok(rows.every((row) => row.props.grip?.props.draggable))
  const applicableId = account === gemini ? 'gemini-pro' : 'premium'
  for (const row of rows) {
    assert.equal(row.props.appliesTo, row.props.bucket.id === applicableId ? model : undefined)
    const rendered = render(quotaUI.BucketRow, row.props).tree
    assert.equal(
      nodes(rendered).some((node) => node.props?.children === 'quota.currentModel'),
      row.props.bucket.id === applicableId
    )
  }
  const before = find(view.tree, quotaUI.Meter).props
  all[0].props.onReorder(ids)
  view = render(quotaUI.QuotaMeter, activeProps, view.context)
  assert.deepEqual(
    find(view.tree, quotaUI.BucketList).props.buckets.map((b) => b.id),
    ids
  )
  assert.equal(find(view.tree, quotaUI.Meter).props.value, before.value)
  assert.equal(find(view.tree, quotaUI.Meter).props.status, before.status)
  const reloaded = render(quotaUI.QuotaMeter, activeProps)
  reloaded.context.values[1] = state.quotas
  reloaded.context.values[4] = true
  assert.deepEqual(
    find(
      render(quotaUI.QuotaMeter, activeProps, reloaded.context).tree,
      quotaUI.BucketList
    ).props.buckets.map((b) => b.id),
    ids
  )
  find(mounted.tree, 'select').props.onChange({ target: { value: account.id } })
  mounted = render(quotaUI.QuotaMeter, props, mounted.context)
  const browsed = find(mounted.tree, quotaUI.BucketList)
  assert.equal(browsed.props.buckets.length, 2)
  assert.equal(typeof browsed.props.onReorder, 'function')
  assert.equal(browsed.props.modelScope, undefined)
  browsed.props.onReorder([...ids].reverse())
  mounted = render(quotaUI.QuotaMeter, props, mounted.context)
  assert.deepEqual(
    find(mounted.tree, quotaUI.BucketList).props.buckets.map((b) => b.id),
    [...ids].reverse()
  )
  assert.equal(find(mounted.tree, quotaUI.Meter).props.value, 2)
}

// Loaded quota with no applicable limits displays '--' with an explanatory label and no Loader2
const unmeteredProps = { provider: gemini, model: 'unmetered-model' }
let unmeteredView = render(quotaUI.QuotaMeter, unmeteredProps)
unmeteredView.context.values[1] = state.quotas
const unmeteredTree = render(quotaUI.QuotaMeter, unmeteredProps, unmeteredView.context).tree
assert.ok(
  nodes(unmeteredTree).some(
    (node) =>
      node.props?.children === '--' &&
      node.props?.title === 'quota.noModelLimit' &&
      node.props?.['aria-label'] === 'quota.noModelLimit'
  )
)
assert.ok(
  !nodes(unmeteredTree).some(
    (node) => node.type === 'Loader2' || node.props?.className?.includes('animate-spin')
  )
)

const settingsSource = readFileSync('src/renderer/src/routes/Settings.tsx', 'utf8')
const escapeOverride = settingsSource.match(/onEscape=\{(\(\) => \{[\s\S]*?\n      \})\}/)[1]
const makeOverride = new Function(
  'resetting',
  'confirmingReset',
  'setConfirmingReset',
  'return ' + escapeOverride
)
assert.equal(makeOverride(true, false, () => assert.fail('busy reset must not cancel'))(), true)
let resetConfirmation = true
assert.equal(
  makeOverride(false, true, (value) => {
    resetConfirmation = value
  })(),
  true
)
assert.equal(resetConfirmation, false)
assert.equal(makeOverride(false, false, () => assert.fail('no confirmation to cancel'))(), false)

let backs = 0
const page = render(pageUI.PageShell, { title: 'test', onBack: () => backs++ })
const dispose = page.context.effects[0]()
const onKey = windowEvents.get('keydown')
for (const event of [
  { key: 'Enter' },
  { key: 'Escape', defaultPrevented: true },
  { key: 'Escape', repeat: true },
  { key: 'Escape', isComposing: true }
])
  onKey(event)
assert.equal(backs, 0)
document.querySelector = () => ({})
onKey({ key: 'Escape' })
assert.equal(backs, 0)
document.querySelector = () => null
onKey({ key: 'Escape', preventDefault() {} })
assert.equal(backs, 1)
dispose()
assert.equal(windowEvents.size, 0)
let consumed = 0
const special = render(pageUI.PageShell, {
  title: 'test',
  onBack: () => backs++,
  onEscape: () => {
    consumed++
    return true
  }
})
special.context.effects[0]()
windowEvents.get('keydown')({ key: 'Escape', preventDefault() {} })
assert.equal(consumed, 1)
assert.equal(backs, 1)
console.log(
  'UI PREFERENCES OK: quota ordering, bot drag/keyboard/RTL/click isolation, alert color, storage, menus and Escape lifecycle'
)
