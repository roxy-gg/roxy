/** HTTP status must survive auth/transport failures so the agent can retry transient errors. */
export class ModelHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ModelHttpError'
    this.status = status
  }
}
