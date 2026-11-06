# Visual Fix Comparisons

Electron renderer captures using isolated canvas fixtures, not personal chats or account data.
Before captures render the affected files from base commit `2dc5983`; after captures render this PR.
Both versions use the same fixture data, window dimensions and macOS layout.
Native traffic lights are outside `webContents.capturePage` and are not included in these images.

## Settings Navigation

| Before                                                                       | After                                                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ![Back shifted right by the native-control reservation](settings-before.png) | ![Back aligned with the sidebar below the native-control area](settings-after.png) |

## Scrolled Browser Tabs

| Before                                                                     | After                                                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ![Scrolled tabs entering the left native-control area](browser-before.png) | ![Scrolled tabs clipped inside the fixed native-control reservation](browser-after.png) |

## Selected Voice Model

| Before                                                                                       | After                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| ![Only the selected voice card is translucent while its sibling is opaque](voice-before.png) | ![Both voice cards preserve the translucent accent surface with selection indicated by the border and badge](voice-after.png) |
