# Native Reverse Engineering Tools

Settings > Reverse Engineering Tools provides optional local REA integration.
Fresh preferences default to **tools off, guidance off, no enabled families**.
Existing prototype downloads are reusable, but its old `enabled` file is not
imported: opting into a prototype MCP service is not opting into native tools.

## Controls

- Before setup, **Download and Install** installs every supported family and
  automatically enables its calls and REA prompt guidance. This single click also
  grants the system-package consent described beside the button; the OS may still
  request administrator approval. Failed/cancelled setup never auto-enables.
- After setup, **Enable Tools + Prompt** switches native calls and adapted REA
  guidance together. Switching off retains dependencies and per-tool choices;
  switching back on needs no downloads. Existing installed dependencies do not
  automatically opt the user in. If no families have been selected, enabling
  selects every supported family; otherwise Detailed View choices are preserved.
- **Detailed View** shows each family, pinned version, dependency requirements,
  install status, vendor/license link, family switch, individual call switches,
  refresh, and lifecycle details. Unsupported families do not block completed setup.
- **Repair** replaces managed dependency files, including private Node/JDK where
  needed. It closes active contexts but never modifies investigation targets.
- Individual installs download only; they do not change enablement or guidance.
- Prompt/schema changes take effect on the next turn of existing chats. Dispatch
  checks live settings, so stale/forged disabled calls cannot run. Policy changes
  close active analysis contexts. User-installed skills remain unchanged.
- Plan does not receive or dispatch these stateful/runtime-capable tools.

## Native Architecture

`engineering-tools.ts` owns installation, preferences, effective policy, catalog,
IPC, and adapted guidance. The same allowlist powers settings and dispatch.
`engineering-runtime.ts` owns private Node child processes keyed by chat/delegate.
`resources/engineering-worker.mjs` imports the **pinned 6.7.0 package**, captures
public handler registration, validates the exact registration schemas, and calls
handlers directly. Upstream evidence, admission, output budgets, and cleanup are
preserved. There is **no REA MCP server, client handshake, listener, or configured
MCP record**, and `ROXY_MCP=0` / `ROXY_SKILLS=0` do not disable native tools.

REA has no stable public embedding SDK. The registration adapter is an explicitly
version-pinned internal seam, not a claim of upstream API stability. Upgrades must
pass live schema/handler tests. An unconnected upstream SDK registration object
is constructed because upstream couples service handlers to it; it has no transport.
JADX's owned Java provider still uses upstream's internal stdio protocol. That is
not an independently registered/background REA service. Do not advertise this as
removing every internal use of MCP from third-party engines.

Stable provider-safe names are `rea_<operation>`. Tool descriptions and schema
prose map operation references to these exact names; result payloads preserve
upstream identifiers/provenance. `rea_tools` discovers and selects enabled native and connected MCP schemas within a 128-function provider budget, instead of blindly concatenating
all 114 supported calls with Roxy/MCP tools. It cannot enable a disabled operation.
The full upstream release has 207 contracts; this integration deliberately offers
only the dependency-backed subset, not engines it cannot install or license.

Each analysis worker retains one chat's target and Evidence across turns. Child
investigations do not share their parent's or sibling's active target. Workers
close on tool-policy changes, session deletion, reset, shutdown, cancellation
fallback, or 30 minutes idle. Export important Evidence before closing. Cancellation
first reaches upstream AbortSignals; a wedged worker receives graceful close and
then owned process-tree termination. Forced termination cannot guarantee that an
external instrumented process/device was restored; it is not a security sandbox.

## Dependencies And Platforms

- REA 6.7.0 plus private Node 24.18.0. System Node is unchanged. Node archives have
  pinned vendor SHA-256 values; REA npm integrity is pinned. REA installs into a
  staging directory with lifecycle scripts disabled before publishing.
- Ghidra 12.1.4 plus private full Temurin JDK 21.0.10+7: automated Windows/Linux
  x64 installs. Windows support is experimental/read-only per upstream.
- Headless JADX adapter 0.7.1 plus the shared JDK. APKs need no attached device.
- Android Platform-Tools 37.0.1: x64 hosts. USB authorization is still manual.
- Frida native Node binding 17.23.2. Only its explicitly selected native-install
  script runs. Device-side Frida servers are **not** silently installed.
- Wireshark/TShark 4.x via winget or apt/polkit, with system-install and
  package-terms consent disclosed beside the action and enforced in main. Saved captures only. Summaries support
  Windows/Linux; field extraction is Linux-only. macOS is not offered because the
  released owned-process pcap adapter refuses it.
- Linux requires a procps-compatible `ps`; package-manager integration currently
  requires apt and polkit. ARM/macOS support is family-dependent and shown in UI.
- Commercial Hopper/IDA/JEB, firmware toolchains, sigrok, WABT, debugger engines,
  and arbitrary caller-supplied tools are not part of this automated toolkit.

Install markers plus executable existence indicate installation, not a recurring
cryptographic attestation of all installed files. Archive checks apply at download;
Frida/package-manager dependencies have their own upstream supply-chain behavior.
REA's package retains MIT and third-party notices; external tools retain vendor
licenses. System packages remain installed after disabling/resetting Roxy.

The adapted guidance follows the release skill's bounded investigation workflow,
not upstream main's evolving README or MCP setup/repair instructions. Switching it
off removes future system injection, not earlier messages or separately user-
installed skills already in conversation history.

## Verification

- `npm run smoke:engineering`: settings/policy/download/cancel tests and real
  mocked-provider host/bot/delegate request capture, including prompt independence
  and schema rotation.
- `npm run smoke:engineering-live`: opt-in existing private installation; executes
  actual native handlers on a ZIP fixture and verifies retained evidence, canonical
  schemas, provenance, isolation and cleanup. Set `REA_RUNTIME_ROOT` / `REA_NODE`
  when the private runtime is elsewhere.
- `npm run smoke:engineering-ui`: real settings UI, one-click setup and unified enablement,
  install consent, desktop and 390px layout. Uses the session dev port 3107.

Live smoke is not proof of every external engine on every OS. Cross-platform
fresh downloads, administrator package-manager flows, attached devices, Frida
injection, and production signed packages require separate integration testing.
