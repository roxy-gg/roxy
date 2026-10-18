# Local Streaming Voice

Voice Translation lives in Settings > General and defaults off. The name is the
requested UI label; the feature is speech transcription, not language translation.
Enabling it does not download a model or open the microphone. Hotkeys start blank
and register only after the user configures them.

## Implementation

- Capture: `@handy-computer/recorder@0.2.1`, the published Node binding of Handy's
  microphone engine. Uses native device selection, 16 kHz mono resampling,
  ordered chunks, and device/stall failure reporting. No Chromium media grant,
  Accessibility grant, clipboard manipulation, or OS text injection is needed.
- Recognition: `sherpa-onnx-node@1.13.8` online transducers, CPU-only, in an
  Electron utility process. No Python/runtime installation. The selected model
  preloads when voice is enabled (including app startup) and stays warm between
  recordings. Each recording creates a fresh stream; stopping closes the mic
  and discards that stream, not the weights. Disable, model switch/removal,
  engine failure, or app exit unloads the process and releases model memory.
  Keeping it warm trades idle RAM for quicker mic activation. Audio is never
  persisted or sent over the network.
- Downloads: four allowlisted, revision-pinned model files per model, exact size
  and SHA-256 validation, temporary directory, verified marker, atomic rename.
  No unverified archive extraction. A failed/cancelled download is not installed.
- Models: Parakeet Unified EN 0.6B streaming 560 ms (~633 MiB), Nemotron Streaming
  3.5 streaming 560 ms (~651 MiB). Canary, offline Parakeet, Whisper, and other
  batch models are intentionally absent. Downloaded models have their own
  licenses, linked on each card; they are not relicensed under Roxy's MIT license.
- Settings are normalized in a dedicated SQLite `voice` row; there is no schema
  migration. Models live under `userData/voice-models`, not the signed app bundle.
- Two optional Electron accelerators both toggle recording. Registration is
  transactional: failures preserve old shortcuts. This is not Handy's native
  hold-to-talk/hybrid/modifier-only hook implementation.
- Recording is bound to one main app window and one recording UUID. Transcripts
  are revisioned snapshots, not appended deltas. Only the verified voice-owned
  input range changes. Typing, sending, route changes, unmounting, disable,
  suspend/lock, renderer loss, and reset cancel it. Already displayed text stays.
- Missing selected microphone falls back to the current system default; the
  user's preference is retained. Default devices are resolved on every start.
  Devices are explicitly refreshed in Settings rather than continuously polled.
- Capture is on-demand, not always-on. Five seconds of outstanding PCM bounds
  slow inference; dictation stops after ten minutes. No transcript/audio logging.
- The mic spinner is the primary startup/finishing feedback. Routine listening
  text is hidden. Startup/finishing text appears above the input only after two
  seconds in that phase; errors and microphone fallback remain immediate.

Supported native targets: Windows x64, macOS arm64/x64, Linux glibc arm64/x64.
Windows ARM64 recognition has no published sherpa prebuilt and is disabled.
Native platform packages and all adjacent DLLs/dylibs are unpacked from ASAR.
macOS includes a microphone usage description and audio-input signing entitlement.

## Handy Investigation

Source inspected at Handy commit `9e57a0d7929fcc6417ea0d6e54c1b57f62635edd`
(0.9.8), and handy-recorder commit
`55748ee70f7b634ca1e5c635016133eae3608c7e`.

- [Handy audio manager](https://github.com/cjpais/Handy/blob/9e57a0d7929fcc6417ea0d6e54c1b57f62635edd/src-tauri/src/managers/audio.rs):
  default resolution, stale-device retry, fallback, first-chunk readiness,
  on-demand capture, cleanup, Bluetooth behavior.
- [Handy Windows permission checks](https://github.com/cjpais/Handy/blob/9e57a0d7929fcc6417ea0d6e54c1b57f62635edd/src-tauri/src/commands/audio.rs):
  desktop (`NonPackaged`) permission differs from the UWP app switch. Roxy does
  not gate Windows capture using recorder's stricter registry permission result;
  actual capture determines availability. macOS requests permission explicitly.
- [Handy shortcut coordinator](https://github.com/cjpais/Handy/blob/9e57a0d7929fcc6417ea0d6e54c1b57f62635edd/src-tauri/src/transcription_coordinator.rs):
  single recording owner and guarded state transitions. Electron globalShortcut
  has no key-up callback, so true global push-to-talk is not claimed.
- [Published recorder API](https://github.com/handy-computer/handy-recorder/blob/55748ee70f7b634ca1e5c635016133eae3608c7e/bindings/node/index.d.ts).
- [Sherpa online Node API](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/scripts/node-addon-api/lib/streaming-asr.js).

REA MCP was used against the installed Handy Windows executable. It identified
PE x64, SHA-256 `8b351d978231f1db031890f6ec909c34982c7973b5834e531c624ec62b20b4b6`.
Resource inventory Evidence:
`ev_29c69ee49741862b07a38f6aac84b3527231618270e365e10a0aed6568f5fd57`.
The local complete bundle is `test/.out/handy-evidence.json` (untracked).
Native code analysis was unavailable (`provider_missing`); this resource
evidence does not establish microphone behavior. Behavioral findings above are
source inspection, not a claim of REA decompilation or runtime parity.

## Verification

Run `npm run smoke:voice` for normalization, catalog, range-merge and service
boundary tests. The service suite mocks OS/native boundaries; it covers off by
default, sender/frame/URL admission, hotkey rollback, live events, stop/flush,
cancel-during-open, verified downloads, corruption and cancellation.

Run the harness with
`node node_modules/vite/bin/vite.js --config test/canvas/vite.config.mjs --port 3105`,
then `npm run smoke:voice-ui`. It exercises real Settings/Composer components with
a fake bridge: narrow layout, catalog search, live revisions, finalization,
shortcuts, edit/send/unmount/hidden-route isolation.

After `npm run build`, `npm run smoke:voice-native` downloads approximately
633 MiB of pinned test data into ignored `test/.out` and runs public prerecorded
English speech through the actual utility-process recognizer under Electron.
`electron test/.out/voice-native.cjs --nemotron` runs the multilingual model
against public Spanish speech (~651 MiB). Both passed on Windows x64 with
Electron 33.4.11, including nonempty text before stop and final flushing.
These probes do not open the user's microphone and are not accuracy benchmarks.

## Remaining Release Checks

This is not a verified 1:1 port of Handy's complete application. Hardware and
signed packaging behavior cannot be proved by source inspection or fake bridges.

- Signed/notarized macOS Intel and Apple Silicon builds: first grant,
  deny/regrant/restart, helper signing, hardened runtime native loading.
- Windows desktop microphone privacy settings, no device, busy device, unplug,
  replug, duplicate devices, system-default changes, and Bluetooth startup delay.
- Native recorder real chunk delivery under Electron; Node binding load was
  tested, but unattended tests deliberately did not capture a live microphone.
- Full packaged ASAR/native-library resolution on clean Windows/macOS machines.
- Sleep/lock during opening, capture and finalization, plus repeated hotkey use.
- CPU real-time factor, latency, long dictation memory, language accuracy, and
  model-specific endpoint behavior on representative hardware. Spanish probe
  produced transcription errors, so no accuracy score is advertised.
- Full transitive native dependency license/notice audit before redistribution;
  direct dependency license texts are included under `resources/licenses`.

Bluetooth bidirectional capture can reduce playback quality. A built-in or USB
microphone avoids this OS limitation. Linux requires ALSA/PulseAudio availability;
Wayland global shortcut support depends on the desktop and Electron version.
