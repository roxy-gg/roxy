/**
 * Parsing and tool-call partitioning for blocking investigation batches.
 * Pure so the harness and smoke tests share the same contract.
 */

/** One investigation in a blocking batch. */
export interface TaskInput {
  description: string
  prompt: string
}

/**
 * Separate batch calls from ordinary tools; the harness runs only the first
 * batch and defers every other call in that model response.
 */
export function partitionToolCalls<T extends { name: string }>(
  calls: T[]
): { tasks: T[]; others: T[] } {
  const tasks: T[] = []
  const others: T[] = []
  for (const c of calls) {
    if (c.name === 'task') tasks.push(c)
    else others.push(c)
  }
  return { tasks, others }
}

/** Coerce an unknown JSON value to a trimmed string, or '' when absent. */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Reject malformed batches rather than silently launching a different task. */
export function parseTaskInput(rawArgs: string): TaskInput[] {
  let input: unknown
  try {
    input = JSON.parse(rawArgs)
  } catch {
    throw new Error('Expected a JSON object with a tasks array containing at least two tasks.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Expected a JSON object with a tasks array containing at least two tasks.')
  const tasks = (input as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks) || tasks.length < 2)
    throw new Error('Expected a tasks array containing at least two tasks.')
  return tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task))
      throw new Error(`Task ${index + 1} must have a description and prompt.`)
    const description = asString((task as TaskInput).description).trim()
    const prompt = asString((task as TaskInput).prompt).trim()
    if (!description || !prompt)
      throw new Error(`Task ${index + 1} must have a description and prompt.`)
    return { description, prompt }
  })
}
