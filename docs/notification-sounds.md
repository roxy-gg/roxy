# Custom notification sounds

Settings > Notifications keeps the existing opt-in switch and completion rules.
The sound library adds a global selection without changing bot/project triggers,
focus suppression, queue handling, toast presentation or the default volume.
Importing or selecting a sound never enables notifications. Test notification
still tests sound and toast explicitly, even when automatic notifications are off.

## Import and persistence

- MP3 or PCM WAV, mono/stereo. WAV accepts 16/24-bit PCM up to 48 kHz.
- Maximum 2 MiB (2,097,152 bytes), duration 0.1 through 5 seconds inclusive.
- Up to 20 custom sounds. Identical bytes reuse an existing entry.
- Import adds an entry but does not select it. The user selects it in the dropdown.
  Delete actions appear beside each custom sound inside that menu, not on the
  settings card. Default cannot be deleted. The adjacent Test button tests both
  the selected sound and the native notification.
- A bounded read and signature check run in main. Chromium validates metadata,
  actual decoding, duration and channel count in a temporary sandboxed renderer,
  with no preload, Node access or remote content and a 10-second timeout.
- Audio is copied to `app.getPath('userData')/notification-sounds/<sha256>.<ext>`
  through a temporary file and rename, before saving the library in SQLite.
- SQLite settings key `notification_sound_library` stores metadata and selected
  ID, not original paths. No audio is uploaded or synced.
- Main only serves registered IDs, validates file size and integrity, and returns
  a bounded data URL. The renderer never receives arbitrary file access.
- Missing, damaged or unplayable custom audio falls back to the bundled chime.
- Deleting the active sound restores Default. Deleting never touches originals.
- Full application reset removes the copied sounds and library. It invalidates
  imports that were already decoding or waiting at the picker.

The library and selection survive app/PC restarts as ordinary persistent app
data. This does not keep Roxy running after quit or enable startup at login.

## Verification

- `npm run smoke:notifications`: existing notification behavior and activation.
- `npm run smoke:notification-sounds`: real WAV/MP3 decoding in Electron,
  boundaries, invalid content, duplicate handling, copied audio, selected sound,
  corruption, deletion, reset and concurrent import capacity. A fresh Electron
  process restores the selected sound after deleting the original file.
- `npm run smoke:notification-sounds-ui`: actual settings component with real
  preload/main IPC and SQLite; native picker is stubbed. Checks opt-in behavior,
  import/selection/reload, playback through the sole Test button, playback fallback, toast continuity,
  deletion, cancellation, errors, untrusted callers and 390px/960px layouts.
  Screenshots are written under `test/.out/notification-sounds-*.png`.
- The UI suite owns port 3100 and uses temporary user data, not the user's data.
- `test/fixtures/notification.mp3` is a generated 660 Hz, 0.5-second sine wave
  encoded with FFmpeg/libmp3lame, not a third-party recording.

No editor, conversion, volume control, per-chat selection or cloud sync is added.
