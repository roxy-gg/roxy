/**
 * Roxy Session Relay — popup.
 *
 * Two states: pair (enter the code Roxy is showing) and send (pick what to
 * transfer for the current tab). All network I/O goes through the background
 * worker, which owns the token.
 *
 * Nothing is captured until "Send session" is pressed. Site access is requested
 * at that moment via `chrome.permissions.request`, so installing this extension
 * does not grant it access to every page you visit.
 */

const app = document.getElementById('app')

/** Ask the worker whether we already hold a token. */
async function status() {
  return chrome.runtime.sendMessage({ type: 'status' })
}

/** The tab the user is looking at — the only one we ever touch. */
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ?? null
}

function originOf(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

function el(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

// ---- pairing ---------------------------------------------------------------

function renderPair(error) {
  app.replaceChildren(
    el(`
    <div class="stack">
      <div>
        <h1>Connect to Roxy</h1>
        <p class="sub">Enter the 6-digit code shown in Roxy under Settings &rsaquo; Browser.</p>
      </div>
      <input type="text" id="code" maxlength="6" inputmode="numeric" placeholder="000000" autofocus />
      <button id="go" disabled>Connect</button>
      ${error ? `<div class="msg err">${escapeHtml(error)}</div>` : ''}
      <div class="hint">Roxy must be running for this to work.</div>
    </div>
  `)
  )

  const code = app.querySelector('#code')
  const go = app.querySelector('#go')
  code.addEventListener('input', () => {
    code.value = code.value.replace(/\D/g, '').slice(0, 6)
    go.disabled = code.value.length !== 6
  })
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !go.disabled) go.click()
  })
  go.addEventListener('click', async () => {
    go.disabled = true
    go.textContent = 'Connecting…'
    const r = await chrome.runtime.sendMessage({ type: 'pair', code: code.value })
    if (r?.ok) render()
    else renderPair(r?.error ?? 'Could not reach Roxy. Is it running?')
  })
  code.focus()
}

// ---- sending ---------------------------------------------------------------

async function renderSend() {
  const tab = await currentTab()
  const origin = tab ? originOf(tab.url) : null

  if (!origin) {
    app.replaceChildren(
      el(`
      <div class="stack">
        <div>
          <h1>Roxy Session Relay</h1>
          <p class="sub">Open a website first — this page has no session to send.</p>
        </div>
        <button class="ghost" id="disconnect">Disconnect from Roxy</button>
      </div>
    `)
    )
    wireDisconnect()
    return
  }

  app.replaceChildren(
    el(`
    <div class="stack">
      <div>
        <h1>Send session to Roxy</h1>
        <p class="sub">${escapeHtml(origin)}</p>
      </div>
      <div>
        <label class="row"><input type="checkbox" id="c-cookies" checked /> Cookies <span class="count" id="n-cookies"></span></label>
        <label class="row"><input type="checkbox" id="c-local" checked /> Local storage <span class="count" id="n-local"></span></label>
        <label class="row"><input type="checkbox" id="c-session" /> Session storage <span class="count" id="n-session"></span></label>
      </div>
      <button id="send">Send session</button>
      <div id="msg"></div>
      <hr />
      <button class="ghost" id="disconnect">Disconnect from Roxy</button>
    </div>
  `)
  )
  wireDisconnect()

  const msg = app.querySelector('#msg')
  const send = app.querySelector('#send')

  send.addEventListener('click', async () => {
    send.disabled = true
    send.textContent = 'Capturing…'
    msg.className = ''
    msg.textContent = ''

    const want = {
      cookies: app.querySelector('#c-cookies').checked,
      localStorage: app.querySelector('#c-local').checked,
      sessionStorage: app.querySelector('#c-session').checked
    }

    try {
      // Site access is requested HERE, from a user gesture, and only for this
      // origin — not at install time for every site.
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
      if (!granted) throw new Error('Access to this site was not granted.')

      const snapshot = await capture(tab, origin, want)
      send.textContent = 'Sending…'
      const r = await chrome.runtime.sendMessage({ type: 'send', snapshot })
      if (!r?.ok) throw new Error(r?.error ?? 'Roxy rejected the transfer.')
      msg.className = 'msg ok'
      msg.textContent = 'Sent. Confirm the import in Roxy.'
      send.textContent = 'Send again'
    } catch (e) {
      msg.className = 'msg err'
      msg.textContent = e?.message ?? String(e)
      send.textContent = 'Send session'
    } finally {
      send.disabled = false
    }
  })

  // Show counts up front so the user knows what they're about to hand over.
  preview(tab, origin).then(({ cookies, local, session }) => {
    app.querySelector('#n-cookies').textContent = cookies == null ? '' : String(cookies)
    app.querySelector('#n-local').textContent = local == null ? '—' : String(local)
    app.querySelector('#n-session').textContent = session == null ? '—' : String(session)
  })
}

/**
 * Counts for the checkboxes. Best-effort: without site permission yet we can
 * still read cookies (that permission is separate), but storage needs the page,
 * so those stay "—" until the user sends.
 */
async function preview(tab, origin) {
  const out = { cookies: null, local: null, session: null }
  try {
    out.cookies = (await chrome.cookies.getAll({ url: origin + '/' })).length
  } catch {
    /* no cookie access yet */
  }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => [localStorage.length, sessionStorage.length]
    })
    if (res?.result) {
      out.local = res.result[0]
      out.session = res.result[1]
    }
  } catch {
    /* needs permission; counts fill in after the user grants it */
  }
  return out
}

/** Build the snapshot Roxy expects (see shared/relay.ts). */
async function capture(tab, origin, want) {
  const snapshot = {
    v: 1,
    origin,
    title: tab.title ?? undefined,
    capturedAt: Date.now(),
    cookies: []
  }

  if (want.cookies) {
    // `getAll({ url })` returns every cookie that would be SENT to that URL,
    // including HttpOnly ones the page itself cannot read — which is the whole
    // reason this goes through the extension API instead of document.cookie.
    const raw = await chrome.cookies.getAll({ url: `${origin}/` })
    snapshot.cookies = raw.map((c) => {
      const row = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        hostOnly: c.hostOnly,
        session: c.session,
        sameSite: c.sameSite ?? 'unspecified'
      }
      if (typeof c.expirationDate === 'number') row.expirationDate = c.expirationDate
      // Carried so Roxy can report it was skipped: partitioned cookies cannot
      // be faithfully recreated there.
      if (c.partitionKey) row.partitionKey = c.partitionKey
      return row
    })
  }

  if (want.localStorage || want.sessionStorage) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [want.localStorage, want.sessionStorage],
      func: (wantLocal, wantSession) => {
        const dump = (store) => {
          const out = {}
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i)
            if (k != null) out[k] = store.getItem(k) ?? ''
          }
          return out
        }
        return {
          local: wantLocal ? dump(localStorage) : undefined,
          session: wantSession ? dump(sessionStorage) : undefined
        }
      }
    })
    if (res?.result?.local) snapshot.localStorage = res.result.local
    if (res?.result?.session) snapshot.sessionStorage = res.result.session
  }

  return snapshot
}

function wireDisconnect() {
  app.querySelector('#disconnect')?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'unpair' })
    render()
  })
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

async function render() {
  const s = await status()
  if (s?.paired) renderSend()
  else renderPair()
}

render()
