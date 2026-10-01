# JevRelay Inference Provider

This folder represents a separate private repository named `jevrelay-provider`.

Deploy it at `api.jevrelay.com`.

## Entire API

```text
POST /v1/decide
```

Request:

```json
{
  "state": {},
  "questions": {}
}
```

Response:

```json
{
  "answers": {},
  "usage": {}
}
```

Authentication:

```text
Authorization: Bearer <JEVRELAY_API_KEY>
```

The service validates the API key, applies a rate or credit limit, calls Jev, and returns the typed response. A small page on `jevrelay.com` can create and revoke these keys.

It does not contain:

- MCP.
- Jev Script execution.
- Playwright.
- Browser or desktop control.
- OAuth.
- User computer state.
- Provider selection.

The public runtime treats this API as one optional decision provider alongside OpenRouter. OpenRouter requests go directly from the local runtime to OpenRouter and never pass through this service.
