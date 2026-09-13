/** Shared real-browser UI; bridge mocks prevent real login and clipboard access. */
module.exports = async ({ win, url, check, evaluate, clickDom, key, wait }) => {
  const target = new URL(url)
  target.searchParams.set('copilot', '1')
  await win.loadURL(target.href)
  await wait(400)
  const panel = 'section[aria-label="Refresh GitHub Copilot login"]'
  const start = `${panel} button`
  check(
    'Copilot: recovery prompt is in chat',
    await evaluate(
      `document.querySelector(${JSON.stringify(panel)}).textContent.includes('GitHub Copilot auth sucks sometimes')`
    )
  )
  check(
    'Copilot: prompt does not start auth until clicked',
    await evaluate('window.__canvasTest.copilotStarts === 0')
  )
  await evaluate(`document.querySelector(${JSON.stringify(start)}).focus()`)
  await key('Enter')
  await wait()
  check(
    'Copilot: keyboard activation starts one device flow',
    await evaluate(
      'window.__canvasTest.copilotStarts === 1 && window.__canvasTest.copilotPolls === 1'
    )
  )
  check(
    'Copilot: only user-facing code appears',
    await evaluate(
      `document.body.textContent.includes('ABCD-1234') && !document.body.textContent.includes('private-device-code')`
    )
  )
  const copy = `${panel} button[aria-label="Click the code to copy"]`
  await clickDom(copy)
  check('Copilot: code copies', await evaluate(`window.__canvasTest.copied.at(-1) === 'ABCD-1234'`))
  const authenticate = `${panel} button:last-of-type`
  await clickDom(authenticate)
  check(
    'Copilot: authenticate opens GitHub without another poll',
    await evaluate(
      `window.__canvasTest.opened.at(-1) === 'https://github.com/login/device' && window.__canvasTest.copilotPolls === 1`
    )
  )
  await clickDom('#switch-provider')
  await clickDom('#switch-provider')
  check(
    'Copilot: switching chats/providers retains pending code',
    await evaluate(
      `window.__canvasTest.copilotStarts === 1 && document.body.textContent.includes('ABCD-1234')`
    )
  )
  win.setContentSize(360, 700)
  await wait(150)
  check(
    'Copilot: narrow code view does not overflow',
    await evaluate(
      `document.documentElement.scrollWidth === innerWidth && document.querySelector(${JSON.stringify(panel)}).scrollWidth <= innerWidth`
    )
  )
  await evaluate(
    `window.__canvasTest.finishCopilot('The code expired before you authorized. Please try again.')`
  )
  await wait()
  check(
    'Copilot: expired device code offers another attempt',
    await evaluate(`document.querySelector('[role="alert"]').textContent.includes('code expired')`)
  )
  await clickDom(start)
  await wait()
  check(
    'Copilot: retry requests a new code',
    await evaluate(
      'window.__canvasTest.copilotStarts === 2 && window.__canvasTest.copilotPolls === 2'
    )
  )
  await evaluate('window.__canvasTest.finishCopilot()')
  await wait()
  check(
    'Copilot: success refreshes providers once and confirms reconnect',
    await evaluate(
      `window.__canvasTest.copilotConnected === 1 && document.querySelector('[role="status"]').textContent.includes('reconnected')`
    )
  )
  check(
    'Copilot: reconnect does not submit or clear the draft',
    await evaluate(`document.querySelector('#composer').value === 'Keep my draft'`)
  )
  await clickDom(`${panel} button[aria-label="Close"]`)
  check(
    'Copilot: success notice is dismissible',
    await evaluate(`!document.querySelector(${JSON.stringify(panel)})`)
  )
  await clickDom('#revoke')
  await evaluate('window.__canvasTest.copilotStartFails = true')
  await clickDom(start)
  await wait()
  check(
    'Copilot: connection failure is actionable, not an endless spinner',
    await evaluate(
      `document.querySelector('[role="alert"]').textContent.includes('Test connection failure') && document.querySelector(${JSON.stringify(start)}).textContent.includes('Try again')`
    )
  )
}
