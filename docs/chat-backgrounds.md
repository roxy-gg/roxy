# Chat Backgrounds

Open **Settings > Appearance** (or **Appearance** from the chat sidebar). The left menu opens **Background** first, with **Color Theme** second. Switching panels preserves unsaved theme JSON; in narrow windows the menu sits above the content.

Choose a local image in **Background**. Changes save automatically. Use **Empty chats only** for a quiet transcript, or **All conversations** with a lower conversation visibility. The preview can show either state.

- **None** uses the image without an effect.
- **Dither** quantizes the image with ordered Bayer thresholds.
- **ASCII** and **Halftone** reconstruct it from colored characters or dots.
- **Scanlines** adds transparent horizontal lines.
- **Haze** softens the image and fades it into the selected theme.
- **Glass composer** adds a theme-tinted translucent surface behind the input, not behind its text or controls.
- **Reset effects** restores visibility, scope, effect and glass defaults without removing the image. **Remove** restores the original solid chat UI.

## Themes And Privacy

Themes continue to own colors, fonts, borders and accents. Backgrounds are device preferences, not theme tokens: switching themes keeps the image, and exporting or sharing a theme JSON does not include it. No image URLs or arbitrary CSS were added to the theme format.

The app accepts PNG, JPEG, WebP and GIF up to 25 MiB and 40 million pixels. It stores a static, metadata-free PNG with a maximum dimension of 2048 pixels in `<userData>/chat-background.json`. The original can be moved or deleted afterward. Animated input is intentionally saved as a still image. No wallpaper is attached to model messages or uploaded by this feature. Local storage is not encrypted.

Effects render once in a worker and reuse the resulting image across previews and chats. Opacity changes and theme changes do not rerun pixel processing. The canvas transcript clears its transparent background each frame; tool cards and standalone diffs retain their existing fills.

Reduced-transparency and increased-contrast system preferences hide artwork and restore solid surfaces. Loading/error states do not masquerade as empty chats.

This implements a global chat background, not per-project overrides or native desktop-window transparency. New localized labels initially fall back to English until the translation workflow runs.
