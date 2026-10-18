# Settings catalog search

Settings includes Skill Search after Discovered Skills and MCP Search after the
configured MCP servers. Browse/search, pagination and reviews use the public
roxy.gg relay. Everything runs on the existing Dokploy backend; no Vercel project,
OIDC token or bridge secret is required.

Production defaults to `https://roxy.gg`. For local relay development set
`ROXY_CATALOG_BASE=http://localhost:3104` before launching Roxy. HTTP is allowed
only on loopback; configured URLs cannot carry credentials, paths or queries.
See the sibling server repository's `docs/catalog.md` for the Postgres migration
and optional GitHub rate-limit token configuration.

Skills search uses the public skills.sh endpoint used by its official CLI.
Empty search shows a bounded starter search for `skills`, not a global leaderboard.
Search results include upstream Skills installs when available. MCP install
counts remain null because the official registry does not publish them. Icon
URLs must be same-relay hashed routes; the server caches raster bytes and the
renderer loads them lazily without cookies/referrers. Missing artwork falls
back to Roxy's skill/MCP glyphs, never blocking discovery.

## Installation

- Skill review lets users inspect SKILL.md and every companion text file. Installing
  writes exactly that bounded snapshot into `~/.roxy/skills/<safe-name>`, using the
  existing name sanitizer for human-readable upstream names. It does not
  install the whole repository or execute scripts. Existing names are refused.
  The relay downloads a public GitHub skill folder at a pinned commit and checks
  file hashes. Unsupported sources, ambiguous folders, binary files and oversized
  bundles stay manual-only instead of installing a partial snapshot.
- MCP setup supports remote Streamable HTTP/SSE and a conservative subset of
  pinned npm/PyPI stdio packages. It prompts for manifest inputs and shows a
  masked command/config preview. Unsupported packaging/runtime semantics are
  left to the existing manual configuration flow, not guessed.
- Confirmation saves and connects an MCP server, potentially downloading and
  running third-party code. Tokens/headers entered here stay on the desktop in
  the existing MCP configuration store; they are never sent to the catalog.
- Review handles are unique, window-local, bounded and expire after ten minutes.
  Confirmation uses the reviewed snapshot, not a freshly fetched manifest.

Run `npm run smoke:catalog`, `npm run smoke:catalog-ui`, `npm run typecheck`,
and `npm run smoke:shared`.
Public search and GitHub snapshots can be live-tested without Vercel credentials.
