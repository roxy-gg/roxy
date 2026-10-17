import { redactImageData } from '../../shared/attachments'

/** HTTP status must survive auth/transport failures so the agent can retry transient errors. */
export class ModelHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(redactImageData(message))
    this.name = 'ModelHttpError'
    this.status = status
  }
}

export class ModelOutputLimitError extends Error {
  readonly outputTokens: number | undefined
  constructor(
    response?: {
      max_output_tokens?: number | null
      usage?: { output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } }
    },
    context?: { model?: string; outputLimit?: number; requestId?: string }
  ) {
    const output = response?.usage?.output_tokens
    const reasoning = response?.usage?.output_tokens_details?.reasoning_tokens
    const limit = response?.max_output_tokens ?? context?.outputLimit
    const details = [
      context?.model && `model=${context.model}`,
      `output=${output ?? 'unreported'}`,
      `reasoning=${reasoning ?? 'unreported'}`,
      `budget=${limit ?? 'unreported'}`,
      context?.requestId && `request=${context.requestId}`
    ]
      .filter(Boolean)
      .join(', ')
    super(
      `Provider ended the response with max_output_tokens (${details}). ` +
        (output === 0
          ? 'The provider reported zero generated tokens; this is not evidence that your task used the output budget.'
          : 'The provider did not complete the response.')
    )
    this.name = 'ModelOutputLimitError'
    this.outputTokens = output
  }
}

/** Providers can fail inside an HTTP 200 SSE stream, on either OpenAI wire. */
export function assertModelStreamEvent(
  event: {
    type?: string
    code?: string
    error?: { code?: string; message?: string } | string | null
    message?: string
    response?: {
      max_output_tokens?: number | null
      usage?: { output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } }
      error?: { code?: string; message?: string } | null
      incomplete_details?: { reason?: string } | null
    }
  },
  context?: { model?: string; outputLimit?: number; requestId?: string }
): void {
  const error = event.error ?? event.response?.error
  if (
    !error &&
    event.type === 'response.incomplete' &&
    event.response?.incomplete_details?.reason === 'max_output_tokens'
  ) {
    throw new ModelOutputLimitError(event.response, context)
  }
  if (
    !error &&
    event.type !== 'error' &&
    event.type !== 'response.failed' &&
    event.type !== 'response.incomplete'
  )
    return
  const detail =
    typeof error === 'string' ? error : [error?.code, error?.message].filter(Boolean).join(': ')
  throw new Error(
    redactImageData(
      `Model stream failed: ${detail || event.response?.incomplete_details?.reason || [event.code, event.message].filter(Boolean).join(': ') || event.type || 'unknown error'}`
    ).slice(0, 500)
  )
}
