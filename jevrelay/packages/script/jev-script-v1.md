# Jev Script v1

Jev Script v1 is a small declarative format for local automation.

The machine-readable schema is [`jev-script-v1.schema.json`](jev-script-v1.schema.json).

## Goals

- Let an AI generate a complete reusable automation.
- Keep execution deterministic except at explicit `decide` steps.
- Prevent generated scripts from gaining arbitrary shell or code execution.
- Make permissions visible before a run starts.
- Keep browser and desktop actions local.

## Top-Level Shape

```ts
type JevScript = {
  version: 1
  name: string
  permissions: {
    origins?: string[]
    applications?: string[]
  }
  inputs?: Record<string, unknown>
  steps: Step[]
}
```

## Step Types

### Action

Runs one allowlisted adapter operation.

```ts
type ActionStep = {
  action: string
  saveAs?: string
  [argument: string]: unknown
}
```

The MVP browser operations are:

```text
browser.goto
browser.fill
browser.press
browser.click
browser.wait
browser.extract
browser.assert
```

Each operation has its own validated arguments. Unknown operations and arguments fail validation before execution.

### Decision

Calls the JevRelay API for a typed, bounded Jev decision.

```ts
type DecisionStep = {
  decide: {
    state: unknown
    question: string
    options?: Record<string, string | null>
    optionsFrom?: string
    minimumConfidence?: number
    saveAs: string
  }
}
```

A decision must select from options supplied by the script or extracted local state. Jev does not produce a browser command, selector, shell command, or free-form script.

If confidence is below `minimumConfidence`, the run stops and returns `needs_input`. The runtime must not guess.

## References

Strings may reference inputs and prior results:

```text
${input.query}
${vars.videos}
${vars.videoId}
```

References are data substitution only. They are not JavaScript expressions and cannot call functions.

## Limits

Every run has local limits even when the script omits them:

```text
maximum duration
maximum step count
maximum retries per action
maximum extracted text size
maximum Jev calls
maximum Jev request size
```

The local runtime enforces these limits. The relay separately enforces account and usage limits.

## Permissions

A script declares the browser origins and desktop applications it may access.

The runtime rejects:

- Navigation to undeclared origins.
- Launching undeclared applications.
- Unknown adapter operations.
- Shell execution.
- Reading arbitrary local files.
- Credential or password extraction.

Sensitive actions such as purchases, sending messages, deleting data, or changing account settings require an explicit approval step outside Jev.

## Result

A run returns one structured result:

```ts
type RunResult = {
  runId: string
  status: 'completed' | 'failed' | 'stopped' | 'needs_input'
  output?: unknown
  error?: {
    step: number
    code: string
    message: string
  }
  usage: {
    localActions: number
    jevCalls: number
    inputTokens: number
    outputTokens: number
  }
}
```

Logs may include action names, durations, and sanitized results. They must not include cookies, access tokens, passwords, or raw credential fields.
