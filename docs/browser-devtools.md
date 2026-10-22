# Browser DevTools

Roxy attaches Electron's Chrome DevTools Protocol (CDP) transport to each browser
page tab. No extension, external Chrome process, debugging port, or MCP server is
required. The tools are registered in the normal built-in Browser catalog.

## Tools

| Tool                      | Purpose                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_console`         | Console text with timestamp, tab id, severity, and source location. Optional `tabId`, `since`, `limit`, and minimum `level`.                                                      |
| `browser_network`         | Paginated request summaries, URL filtering, HTTP status, duration, redirects, and transport failures.                                                                             |
| `browser_network_request` | One request's headers, initiator, timing, cache/service-worker flags, and optional request/response bodies.                                                                       |
| `browser_evaluate`        | JavaScript evaluation, awaited promises, returned values, and exception details.                                                                                                  |
| `browser_debug_events`    | Structured console arguments, exception/rejection stacks, browser logs, WebSocket events, parsed scripts, and debugger pause/resume events. Supports `after`/`nextAfter` polling. |
| `browser_devtools`        | Page-scoped CDP commands for DOM/CSS, accessibility, emulation, debugging, and performance/profiling.                                                                             |

Diagnostics tools default to the active tab. Pass `tabId` from `browser_tabs` to
inspect another tab in the same chat. Results identify the selected tab, and an
in-flight operation cannot be redirected by switching the active tab. Request
handles belong to one tab and become invalid after eviction or tab closure.

## Typical Workflows

Network debugging: open the site, reproduce the issue with browser interactions,
call `browser_network`, then use a returned request `id` with
`browser_network_request`. Set `requestBody` or `responseBody` only when needed.
Binary response bodies retain CDP's `base64Encoded` flag. Redirect hops are
separate records; their old bodies are explicitly unavailable.

JavaScript debugging: call `browser_devtools` with `Debugger.enable`, set a
breakpoint with `Debugger.setBreakpointByUrl`, and reproduce the issue. Read
`browser_debug_events` for the current `paused` call frames. Use
`Debugger.evaluateOnCallFrame` or `Runtime.getProperties` to inspect locals, then
`Debugger.resume` or a stepping command. Finish with `Debugger.disable`.

Performance: use `Performance.getMetrics` for heap/DOM/script metrics. For a CPU
profile, call `Profiler.enable`, `Profiler.start`, reproduce the operation, then
`Profiler.stop` and `Profiler.disable`. Large raw CDP results are bounded and
explicitly marked truncated, not advertised as complete profiles.

## Scope and Limits

- Capture starts before the tab's first requested navigation and survives later
  navigations. It does not recover history from a previous app run.
- Each tab retains at most 300 request records and 300 protocol events. Values,
  headers, bodies, and raw command results are also capped; results report
  eviction counts and truncation/unavailability rather than fabricating data.
- Chromium retains response resources within a 16 MiB total / 1 MiB per-resource
  CDP buffer. Bodies are read on demand, may be evicted, and return at most
  100,000 characters (20,000 by default).
- Headers come from CDP's primary request/response events. Extra-info-only headers
  such as browser-added cookies may be omitted. Headers are capped at 60 fields
  and 1,000 characters per value; URLs at 4,000 characters.
- Only the page target is attached. Separate workers, service workers, and
  cross-process iframe targets are not automatically attached. A response's
  `fromServiceWorker` flag is not a worker execution trace.
- Browser/Target-wide commands, cookie methods, deliberate page crashes, and
  disabling the capture domains are blocked. Supported command domains are
  listed in `src/main/services/browser-devtools.ts`.
- Opening visual DevTools can detach Electron's CDP connection. Tools report the
  detach reason and partial retained history. Close and reopen that tab to
  restore capture; Roxy does not fight the user's DevTools by auto-reattaching.
- The Settings-opened manual browser remains separate from chat-owned browsers.
  Chat tools do not silently inspect it. Logins/cookies still share the existing
  persistent browser partition.

## Sensitive Data and Execution

Network details hide common credential headers by default. `includeSensitive`
explicitly reveals them. URLs, bodies, console arguments, evaluation results,
and low-level CDP command results can contain secrets and are not automatically
redacted. Page/network content is untrusted data, never tool instructions.

JavaScript and CDP commands can change the page. Commands stop waiting after
30 seconds; evaluation also supplies a renderer execution timeout (5 seconds by
default). Stop/cancellation does not roll back execution, resume a debugger,
or stop a profiler. Do not automatically retry uncertain mutations. Explicitly
resume/stop instrumentation, or close the tab when finished.

## Verification

`npm run smoke:browser-devtools` runs a real Electron browser against a local HTTP
fixture, covering first-navigation capture, JSON/POST/binary bodies, redaction,
redirects, HTTP/transport failures, exceptions/rejections, evaluation, debugger
locals/resume, CPU profiling, chat/tab/manual-window isolation, pagination,
retention, cancellation-before-dispatch, detach, closure, and reopening.
