# JevTools Relay

The relay is a hosted service, not an end-user package.

## Minimum API

```text
GET  /oauth/authorize
POST /oauth/token
POST /v1/decide
GET  /v1/usage
```

`POST /v1/decide` accepts the Jev state and typed questions, checks the user's allowance, calls the TypeSafe API with the server-side key, records usage, and returns the typed answers.

## Rules

- Never accept browser cookies or website credentials.
- Never execute a Jev Script remotely.
- Never send raw desktop screenshots by default.
- Use short-lived access tokens and rotating refresh tokens.
- Apply account, request-size, and rate limits before upstream inference.
- Return upstream token usage so the local runtime can report cost.
- Store only the minimum metadata required for billing and abuse prevention.

The first implementation can be one small HTTP service. It does not need queues, workers, or a separate routing service until measured load requires them.
