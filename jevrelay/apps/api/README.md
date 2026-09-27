# JevRelay API

The hosted service deployed at `api.jevrelay.com`.

## Minimum API

```text
GET  /oauth/authorize
POST /oauth/token
POST /v1/decide
GET  /v1/usage
```

`POST /v1/decide` checks the user's allowance, calls the TypeSafe Jev API with the server-side key, records usage, and returns typed answers.

## Rules

- Never accept browser cookies or website credentials.
- Never execute a Jev Script remotely.
- Never send desktop screenshots by default.
- Use short-lived access tokens and rotating refresh tokens.
- Enforce request-size, account, and rate limits before inference.
- Return inference usage to the local runtime.
- Store only the metadata needed for billing and abuse prevention.

Start with one small HTTP service. Do not add queues or a separate routing service until measured load requires them.
