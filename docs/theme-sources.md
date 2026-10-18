# Desktop Theme Sources

Inspected 2026-10-18. Claude Code and Codex IDs are retained for saved selections;
these map desktop app tokens, not terminal CLI themes. They are not vendor-endorsed
themes or pixel-for-pixel app clones. No colors were sampled or guessed from screenshots.

## Evidence

Claude Windows package version 2.42304.0.0, app/resources/app.asar:

- ASAR SHA-256: `8f4d3dec5e4f3ddffb150321060b18807d83a40f3a65618fe4f29325379da9db`.
- CSS member: `.vite/renderer/main_window/assets/MainWindowPage-DTxMhyWF.css`.
- CSS SHA-256: `16ae317b1762db1a556d1b8e6c872eab361a6a7530ffa67962b1682aa4582362`.
- Partial REA analysis: `ev_59e5cd2233dc200186662a3de1ee1f4d47059d275745596a33542a22ddb2097b`.

OpenAI.Codex Windows package 26.1013.4894.0, app/resources/app.asar:

- ASAR SHA-256: `bbec1d64e135b718a154b31655bb8ad9a39472bac1b2cabba991a9d97a339dd8`.
- Internal version 26.1013.40934, build 20770. Manifest display name is ChatGPT;
  the package has a shared ChatGPT/Codex desktop theme provider.
- CSS member: `webview/assets/app-shared-dc7535e633d7.css`.
- CSS SHA-256: `282dd3546bccfba48212a186641a73dedb27af6af7962dad40b3f5db6a9a08f2`.
- JS member: `webview/assets/app-initial-5851df3f6cb1.js`.
- JS SHA-256: `c70d95da34ba7e5962a559dbf68d0102d10b4b47b877f5d9933629bb5a1f3a10`.

REA found integrity mismatches in unpacked native companions of both apps. Claude
record-and-continue retained those contradictions and timed out during JS analysis.
This is not complete application analysis. CSS members were separately read as
inert bytes, then verified in a derived ZIP by REA inventory
`ev_81cacce2c7fae28982811a7aacfc67430932507115183aea4be87257f8652254`.
The inventory authenticates extracted bytes, not their runtime use. No vendor code
was executed; no authentication, conversations or preferences were used. Extracted
assets remain in ignored test/.out and are not distributed.

## Claude

Use the current CDS tokens, not the older HSL palette also present in the package.

| Roxy         | Source role                     | Light   | Dark    |
| ------------ | ------------------------------- | ------- | ------- |
| bg           | claude-background-color         | #fcfcfb | #151515 |
| surface      | cds-surface-1                   | #fcfcfb | #151515 |
| surface-2    | cds-surface-2                   | #ffffff | #1a1a19 |
| elevated     | cds-surface-popover / surface-3 | #ffffff | #20201f |
| text         | cds-text-primary                | #0b0b0b | #f0efec |
| text-muted   | cds-text-secondary              | #52514e | #c3c2b7 |
| text-subtle  | cds-text-muted                  | #898781 | #898781 |
| accent       | cds-text-accent                 | #184f95 | #6da7ec |
| accent-hover | cds-role-accent-fill-hover      | #3987e5 | #3987e5 |
| success      | cds-text-success                | #006300 | #0ca30c |
| warning      | cds-text-warning                | #734500 | #db9300 |
| danger       | cds-text-danger                 | #8e2626 | #ec7e7e |

Borders are neutral-900 at 10% / 20%. Primary polarity maps fill-primary and
on-primary. Float shadows copy cds-shadow-popover per mode; top-lit bevels are off.
Compact circular radii are 5px small, 6px base, 7px large, 10px card, 12px composer
at a 16px root. These map to Roxy size roles, not identical component counterparts.

The CSS defines anthropic-sans with variable Anthropic Sans WOFF2. Mono starts
with an optional Anthropic Mono override, then SF Mono and system monospace. Roxy
references installed Anthropic Sans with system fallbacks. Private font files are
not copied, loaded from another app, or redistributed. The screenshot greeting
uses a separate Anthropic Serif role absent from Roxy's typography model.

## Codex

The f9o seed registry (JS UTF-16 offset 8031443) defines Electron defaults:
light surface #ffffff, ink #1a1c1f, contrast 45; dark surface #181818, ink #ffffff,
contrast 60; both accent #339cff. Des/Mes/Nes/kes/jes/Oes derive the CSS variables
(offsets 8050923-8066280). RGB interpolation rounds channels and alpha is formatted
to three decimals. Calculations were reproduced from inspected arithmetic without
executing the packaged functions.

| Roxy          | Source role                        | Light       | Dark           |
| ------------- | ---------------------------------- | ----------- | -------------- |
| bg            | background-surface                 | #ffffff     | #181818        |
| surface       | surface-under                      | #f6f6f6     | #141414        |
| surface-2     | editor-opaque                      | #ffffff     | #282828        |
| elevated      | elevated-primary opaque            | #ffffff     | #363636        |
| text          | foreground, default dark exception | #1a1c1f     | #dfdfdf        |
| text-muted    | secondary CSS fallback             | ink at .65  | #dfdfdf at .65 |
| text-subtle   | foreground-tertiary                | ink at .495 | white at .498  |
| border        | generated border                   | ink at .078 | white at .084  |
| border-strong | generated heavy border             | ink at .117 | white at .156  |
| success       | semantic diffAdded                 | #00a240     | #40c977        |
| danger        | semantic diffRemoved               | #ba2623     | #fa423e        |
| warning       | app-color-text-warning             | #e25507     | #ff8549        |

Accent-hover maps light blue-500 (#0169cc) and dark icon-accent, the seed mixed
39% toward white (#83c3ff). These are explicit role mappings: Roxy has only one
accent/hover pair. Account accents can replace the seed; private customizations
were not read. Roxy's high-contrast button polarity is retained; source dark
button fill/text do not map one-to-one onto the shared Roxy polarity pair.

Default UI stack is -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif.
Code is ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono,
monospace. OpenAI Sans is bundled, but the fNl activation guard is compiled false;
it is not assumed to be the active default.

Radius bases: sm .375rem, md .5rem, lg .625rem, xl .75rem, 2xl 1rem. Supported
desktop CSS uses corner-shape:superellipse(1.5) and scale 1.25. Roxy's older
Chromium emulates that with exponent 2 \*\* 1.5 instead of its default 4. The
containing circular radius coefficient comes from the superellipse diagonal,
not a vendor token. Composer uses its own 1.375rem radius. Raised/float shadows
map the shipped sm/lg shadow tokens; bevels are disabled.

## Limits

- These are shipped token defaults, not observed effective DOM styles of the
  current user. Transparency, density, account accents and local overrides vary.
- Roxy layout, font sizes/weights, syntax highlighting and component roles remain
  Roxy's. A theme does not replace those components with vendor components.
- Exact Anthropic typography requires licensed, available fonts. Naming a font
  is not proof it is loaded. Proprietary font assets are not redistributed.
- Source colors are not recolored to satisfy our old accent-brightness heuristic.
  Translucent text contrast is measured after compositing over its actual surface.
