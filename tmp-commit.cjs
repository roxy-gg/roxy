const fs = require('fs')
const { execSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')

const MSG = `fix(mcp): deliver host messages to the opaque sandbox frame

Every MCP App rendered as a blank frame with no error on any channel. The
proxy document loaded and announced itself, the host replied, and the reply
was silently discarded - so the proxy waited forever for HTML that had in
fact been sent.

Cause: the proxy frame is \`sandbox="allow-scripts"\` WITHOUT
\`allow-same-origin\`, which is deliberate - it is what makes the document
opaque so it cannot reach Roxy's storage. But an opaque document's origin is
not its URL, so posting to \`roxy-mcp-app://view\` matched nothing.

The obvious repair is also wrong: the browser rejects the literal \`'null'\`
outright ("Invalid target origin 'null' in a call to 'postMessage'"). No
origin string addresses an opaque frame, so \`'*'\` is forced.

That costs nothing here, and the reasoning is now written down rather than
left to be rediscovered. The targetOrigin was never the control doing the
work: the only reader is the frame we created and hold a handle to, which
cannot navigate away, and authenticity is enforced on the receiving side -
the host checks \`event.source === frame.contentWindow\` (exact window
identity), and the proxy pins the host's real origin from the first message.

The test that should have caught this loaded the proxy TOP-LEVEL, where it
reports the scheme origin the product never sees. It now loads inside a real
sandboxed iframe, asserts the origin is opaque, and drives the full round
trip (host -> proxy -> view -> host) so a dropped reply fails here instead of
as a blank frame.

Co-authored-by: Roxy <299891354+roxy-commits@users.noreply.github.com>`

const msgPath = path.join(os.tmpdir(), 'roxy-fix-msg.txt')
fs.writeFileSync(msgPath, MSG)
execSync('git add -A', { stdio: 'pipe' })
execSync(`git commit -q -F "${msgPath}"`, { stdio: 'pipe' })
fs.rmSync(msgPath, { force: true })
console.log(execSync('git log --oneline -1', { encoding: 'utf8' }).trim())
