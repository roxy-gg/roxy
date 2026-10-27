# Native Input Listener

Roxy uses uiohook-napi 1.5.5 (MIT) and its linked libUIOHook library
(LGPL-3.0-or-later, copyright 2006-2023 Alexander Barker and contributors).
The MIT wrapper and LGPL library are separate from Roxy's MIT license.

- Wrapper: https://github.com/SnosMe/uiohook-napi
- Library: https://github.com/kwhat/libuiohook
- Licenses: `LICENSE.uiohook-napi`, `COPYING.LESSER.md`, and `COPYING.md` beside this notice.
- Corresponding native source, wrapper, patches, and build configuration:
  `uiohook-napi-1.5.5-source.tgz` beside this notice, the unmodified published
  npm source archive for the pinned dependency.
  SHA-256: `21b489ee141e5d2e82ec595510e8b7dd6c2d9c91266f4094be3bfe04e0a33acd`.

The native addon remains an external, unpacked dependency, not embedded in
Roxy's JavaScript bundle. Users may modify and rebuild it, including libUIOHook,
and replace the interface-compatible addon. The archive includes `binding.gyp`
and native sources; install its `node-gyp-build` dependency and run
`npm rebuild uiohook-napi --build-from-source` with the platform C/C++ toolchain
and required X11 libraries on Linux. For Electron-specific rebuilding use
`npx electron-rebuild -f -w uiohook-napi` against the application's Electron
version. No terms in Roxy restrict reverse engineering for debugging such
modifications. Roxy's corresponding application source and build instructions
are available at https://github.com/roxy-gg/roxy.
