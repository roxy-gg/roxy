# Provider Accounts

Provider catalog entries and connected accounts have separate identities:

- `ConnectedProvider.seedId` identifies a catalog entry and controls protocol behavior, logos, and public model metadata.
- `ConnectedProvider.id` identifies a saved connection and scopes credentials, sessions, model preferences, usage, and private model catalogs.
- A provider-specific counter generates stable account numbers. New connections never ask for a name; Settings can rename them afterward.
- Existing provider IDs are preserved during migration so saved chats and model preferences keep pointing to the same connection.

## Authentication

API-key and local endpoint connections create new rows by default. Updating an existing connection requires an explicit `connectionId`.

GitHub Copilot tokens, refresh promises, reauthentication state, and model catalogs are connection-scoped. Credential rotation uses compare-and-swap, and a reconnect starts a new credential session. GitHub identity is resolved before saving interactive sign-in. Reauthentication must match the original GitHub user ID.

Subscription connections share one CLIProxy process but bind to individual auth files. Each file gets a deterministic, unique model prefix. Model discovery uses that file's catalog; inference adds the prefix at the wire boundary. Missing or unusable bindings fail closed instead of falling back to the proxy's credential pool. Account sign-out removes only the bound file.

## Selection

Session provider/model pairs continue to store connection IDs. An explicitly selected account that has been disconnected must not resolve to the first remaining connection. Display names do not participate in routing and renaming does not change saved selections.

## Verification

- `npm run typecheck`
- `npm run i18n`
- `npm run smoke:shared`
- `npm run smoke:i18n`
- `npm run smoke:store`
- `npm run smoke:provider-models`
- `npm run smoke:app`
- `npm run smoke:cliproxy`

The provider model test mocks HTTP and checks independent local endpoints and private API-key catalogs. Copilot tests use real credential persistence with mocked authorization, refresh, and catalog responses. CLIProxy smoke tests exercise the pinned sidecar using synthetic auth files, not paid-account inference.

For the Settings/model-picker browser fixture, start `npx vite --config test/canvas/vite.config.mjs --port 3101`, then run `npx electron test/canvas/providers.cjs`. The fixture is at `/providers.html` and uses mock accounts, never real credentials.
