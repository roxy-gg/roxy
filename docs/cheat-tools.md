# Cheat Engineering Tools

Settings > Cheat Engineering Tools is independent of REA and defaults off.
The master switch enables the selected native calls and their system-prompt
guidance. Enabled calls execute directly: there is no per-call approval panel,
approval IPC, approval ID or two-minute permission expiry.

This is a user-mode Windows toolkit, not complete Cheat Engine/ReClass.NET
feature parity, a kernel-access service or a sandbox for an agent with shell
access. Only inspect and modify software the user owns or is authorized to test.
Memory/tool results enter transcripts and may be sent to the selected model.

## Settings and Catalog

The Native Tool Calls section shows all 27 names, model-facing descriptions,
parameter definitions and individual switches, even with the master switch off.
Select All Calls / Deselect All Calls changes the selection, not master enablement.
Selections persist in `cheat-tools/preferences.json` as `disabledCalls` and survive
master-off, restart and source downloads. Reset restores default-off/all-selected.

The Exact Agent Prompt panel uses the same `cheatGuidance()` generator as main.
It includes an authoritative list of enabled calls followed by workflow guidance.
It is empty when the master switch is off, the platform is unsupported, or every
call is deselected. The descriptions and JSON schemas displayed in Settings are
the actual model-facing definitions, not separately maintained summaries.

Model requests and discovery receive only enabled schemas. Dispatch rechecks
current settings, so stale/hallucinated disabled calls cannot execute. Eligible
build-agent host/bot/delegate loops refresh the Cheat catalog and injected guidance
before each model step, including changes during an existing turn. Plan and
limited-tool agents do not receive this family. Provider function-count limits
can hide some enabled definitions; `rea_tools` discovers and rotates them into
the next request without enabling disabled operations.

These controls govern call names, not semantic capability isolation: for example,
disabling raw `cheat_write_memory` does not disable the separately selectable
`cheat_write_value`, which intentionally uses the same backend. Settings changes
clear selected targets and retained scans and cancel pending work. Already
dispatched writes/DLL execution cannot be undone by changing a switch.

## Tool Calls

| Group                     | Calls                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Process                   | `cheat_list_processes`, `cheat_open_process`, `cheat_close_process`                                                          |
| Memory                    | `cheat_list_modules`, `cheat_list_regions`, `cheat_read_memory`, `cheat_write_memory`                                        |
| Patterns and pointers     | `cheat_scan_memory`, `cheat_pointer_chain`                                                                                   |
| Typed values              | `cheat_read_value`, `cheat_write_value`                                                                                      |
| Retained scans            | `cheat_scan_values`, `cheat_refine_scan`, `cheat_list_scans`, `cheat_read_scan`, `cheat_delete_scan`                         |
| Structure metadata        | `cheat_structure_create`, `cheat_structure_read`, `cheat_structure_update`, `cheat_structure_delete`, `cheat_structure_list` |
| Structure decoding/export | `cheat_read_structure`, `cheat_export_structure`, `cheat_inspect_reclass`                                                    |
| DLL                       | `cheat_inspect_dll`, `cheat_build_dll`, `cheat_load_dll`                                                                     |

## Runtime Semantics

Process targets and scan observations are isolated by chat and acting bot. A target
binds PID plus creation time and stays selected until closed, replaced, settings
change, chat deletion or shutdown. Delegates do not inherit targets. Closing a
target does not terminate it, revert a write or unload a DLL.

The original C# helper runs in Windows PowerShell/.NET Framework. Reads return
actual bytes, not invented zero-fill. Writes use WriteProcessMemory immediately;
`expected` is an optional compare-before-write integrity check, not permission.
Results include bytes written and readback verification. Page protections and
Windows permissions still apply; the tool does not change protections, elevate,
enable debug privilege, or load a driver. Failure/cancellation may follow partial
or fully committed changes. No atomic snapshot or rollback guarantee is provided.

Reads/writes are limited to 64 KiB per call. Byte scans use at most 16 MiB, 512
matches and a 15-second search budget. Page larger ranges across calls. These
resource budgets bound output/memory/time, not a simulation of the underlying
operations. Helpers have a 30-second response deadline and a 2 MiB output budget.

Typed values support signed/unsigned 8/16/32/64-bit integers, float32/64,
target-width pointers, UTF-8, UTF-16LE and bytes. Strings preserve integer
precision. No text terminator is automatically appended. Partial reads are not
decoded as complete values. Numeric scans retain up to 8192 candidates with
explicit original coverage; refinement compares with the last retained bytes or
a supplied value. Results can be incomplete due to caps/gaps; retained pages are
observations, not current live reads. Scans are cleared on target/config changes.

Structures are persisted explicit Roxy definitions, not live ReClass objects.
Fields declare names, offsets, types and counts; updates/deletes require the
current revision to avoid overwriting stale metadata. Runtime structure reads
use one contiguous bounded read and preserve incomplete fields. C++ exports use
packed fixed-width layout, padding and size/offset assertions; they are not
recovered original source. Nested/custom nodes, automatic type recovery,
ReClass plugin synchronization and automatic pointer discovery are not provided.

ReClass `.rcnet` inspection only reads ZIP/Data.xml declarations. It does not
extract files, evaluate address formulas, or resolve custom/nested class layouts.
Archive/XML sizes, declaration counts and XML depth are bounded; external XML
resolution and DTDs are disabled.

## DLL Semantics

DLL inspection reads local PE declarations and SHA-256 without executing code;
use REA for decompilation and deeper analysis. DLL builds compile local C++ with
installed Visual Studio C++ tools and Windows SDK into a fresh directory beneath
`cheat-tools/builds`. They do not run the artifact, install a compiler or execute
arbitrary MSBuild project scripts. Building untrusted source is not sandboxed.

`cheat_load_dll(path, sha256?)` directly loads a native x64 DLL in the selected
native AMD64 target using the standard Windows loader. The optional hash check
rejects changed files before dispatch. DLL entrypoints and dependencies execute
inside the target. Dependencies are not hash-pinned and loader behavior is not
a safety guarantee. Relative/network/device/reparse DLL paths and application
`.local` redirection are rejected. The mapped loader export is resolved in the
target rather than assuming identical local/remote module addresses.

Loaded status requires post-call module observation by path; it does not prove
behavior or mapped-byte identity. Timeout/cancellation can leave loader execution
running. The helper retains the selected file lock, path allocation and process/
thread handles until completion or target exit, blocking concurrent loader
retries while it owns the process. Unknown outcomes must not automatically retry.
There is no manual mapping, cloaking, hijacking, protection bypass, arbitrary
internal/export invocation, automatic DLL unload or rollback.

## Optional Upstream Sources

The collapsed source-download section saves official, commit-pinned source ZIPs.
They are not dependencies, connected providers, installed applications or evidence
of feature parity. They are not extracted, built or launched. SHA-256 identifies
received bytes but is not independent signature verification. ReClass.NET uses
MIT with separately licensed dependencies; review Cheat Engine terms before
building/redistribution or derivative integration. x64dbg/IDA remain external
resources, not connected providers.

Existing settings and pinned source archives migrate from the former
`anti-cheat-tools` folder without overwriting newer files. Conflicting originals
are preserved. Public API/IPC and settings routes use `cheat`; tool calls use
`cheat_*`. Retired approval/`ace_*` calls are not executable aliases. Existing
transcripts are not rewritten.

The requested GuidedHacking injector was inspected but is not bundled or invoked.
Upstream commit `e3c6eab04943b10881a7039dc27ff964c79fcb64` has a source-available
license restricting distribution. The supplied local folder contains source,
not binaries, and only a three-byte MIT label, which does not resolve provenance.
The loader/build/inspection helpers are original implementations, not copies of
that injector, and do not provide its stealth/manual-map/hijacking methods.

## Verification

- `npm run smoke:cheat`: catalog/dispatch gates, individual settings, direct operations and migration.
- `npm run smoke:engineering`: real host/bot catalogs, Plan gate, discovery and mid-turn catalog/prompt changes.
- `npm run smoke:cheat-ui`: full inspectable catalog, selections, exact prompt, no approval panel and mobile layout.
- `powershell -NoProfile -File test/cheat-memory.ps1`: original helper against its own test allocation only.
- `npm run smoke:cheat-dll`: actual original DLL build/load in an original disposable host, never another app/game.
