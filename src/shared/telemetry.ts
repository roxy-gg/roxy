/**
 * The closed vocabularies behind anonymous usage tracking.
 *
 * Every value this app reports about a turn is produced here, and every
 * function in this file is TOTAL over its input: hand it anything at all and it
 * returns one of a small, fixed set of strings that ship in this repo. That is
 * the entire design. Telemetry's privacy risk is not the counters, it is the
 * strings - a model id, an MCP tool name, or an error message can each carry a
 * user's private endpoint, their employer's internal service name, or an
 * absolute path with their name in it, and any of those would act as a
 * near-unique fingerprint stamped on every event that install ever sends.
 *
 * So the rule is: the wire format cannot express those things. Not "we don't
 * currently send them" - cannot. A classifier that maps to a fixed set is
 * unbypassable in a way that a code review convention is not, and it fails
 * safe: an id nobody anticipated lands in `other` rather than leaking.
 *
 * Living HERE (shared/, not main/) is deliberate: this module is pure, has no
 * Electron or database imports, and is therefore exercised directly by the
 * pure-Node `npm run smoke:shared` suite. The privacy guarantees are the part
 * that most needs tests, so they are the part that must be trivially testable.
 */

/**
 * Coarse model families we report instead of model ids.
 *
 * WHY NOT THE MODEL ID. It is the single most requested breakdown and the most
 * dangerous string in the app. Model ids are unbounded: Ollama and LM Studio
 * run whatever the user named their local weights (`acme-support-bot-v3`), and
 * gateways pass through arbitrary vendor strings. Publishing that field would
 * mean an install running one bespoke finetune is identifiable forever, from a
 * field we added to draw a pie chart.
 *
 * WHY A FAMILY IS ENOUGH. The product question is "which class of model do
 * people point Roxy at" - frontier Anthropic vs frontier OpenAI vs a local
 * 8B - and the family answers it exactly. The minor version almost never
 * changes the answer, and when it does, it changes it for a month.
 *
 * The list is intentionally shorter than the set of models that exist. Anything
 * unmatched is `other`, which is a real and useful bucket rather than a
 * failure: a rising `other` share is the signal to add a family, and until then
 * it is honest about being unresolved.
 */
export type ModelFamily =
  | 'claude-opus'
  | 'claude-sonnet'
  | 'claude-haiku'
  | 'gpt-5'
  | 'gpt-4'
  | 'openai-reasoning'
  | 'gpt-oss'
  | 'gemini-pro'
  | 'gemini-flash'
  | 'grok'
  | 'llama'
  | 'qwen'
  | 'deepseek'
  | 'mistral'
  | 'kimi'
  | 'glm'
  | 'command'
  | 'gemma'
  | 'phi'
  | 'other'

/**
 * Ordered family patterns. FIRST MATCH WINS, so the order is load-bearing:
 * `openai-reasoning` (o1/o3/o4) precedes the `gpt-4`/`gpt-5` rules because
 * several reasoning ids also carry a `gpt` prefix, and `claude-*` tiers precede
 * any generic vendor rule.
 *
 * Patterns match a SUBSTRING of the lowercased id on purpose - real ids arrive
 * as `anthropic/claude-sonnet-4-5`, `claude-3-5-sonnet-20241022`, and
 * `bedrock/anthropic.claude-sonnet-4-v1:0`, and all three are the same family.
 */
const MODEL_FAMILY_PATTERNS: [RegExp, ModelFamily][] = [
  // Anthropic tiers. Matched before anything generic so a gateway-prefixed id
  // still resolves to its tier rather than falling through.
  [/opus/, 'claude-opus'],
  [/sonnet/, 'claude-sonnet'],
  [/haiku/, 'claude-haiku'],
  // An unrecognised Claude tier is still clearly a Claude; report the modal
  // tier rather than `other`, which would hide a whole vendor behind a bucket.
  [/claude/, 'claude-sonnet'],

  // OpenAI reasoning models. BEFORE the gpt rules: `o3` and friends are a
  // different product line, and some ship under ids that also say "gpt".
  [/(^|[^a-z0-9])o[1-9](-mini|-preview|-pro)?([^a-z0-9]|$)/, 'openai-reasoning'],
  // Open-weight OpenAI models run locally - a different story from the API.
  [/gpt-?oss/, 'gpt-oss'],
  [/gpt-?5/, 'gpt-5'],
  [/gpt-?4|chatgpt/, 'gpt-4'],

  [/gemini.*flash|flash.*gemini/, 'gemini-flash'],
  [/gemini/, 'gemini-pro'],
  [/grok/, 'grok'],

  // Open-weight families, by weight name rather than by whoever is hosting
  // them - the same Llama is the same story on Groq, Together, or localhost.
  [/llama/, 'llama'],
  [/qwen|qwq/, 'qwen'],
  [/deepseek/, 'deepseek'],
  [/mistral|mixtral|codestral|devstral|magistral/, 'mistral'],
  [/kimi|moonshot/, 'kimi'],
  [/glm|chatglm/, 'glm'],
  [/command-?[ar]|cohere/, 'command'],
  [/gemma/, 'gemma'],
  [/phi-?\d/, 'phi']
]

/**
 * Map a model id to its coarse family, or `other`.
 *
 * Total by construction: any string, including a private finetune name, an
 * empty string, or a 10KB blob, returns one of the shipped families. The input
 * is never echoed, so nothing about an unmatched id survives this call.
 */
export function modelFamily(modelId: string | null | undefined): ModelFamily {
  if (typeof modelId !== 'string') return 'other'
  // Bounded before the regex sweep: these patterns run against attacker-ish
  // input (a gateway can return any id), and an unbounded string is how a
  // pathological match turns into a stalled turn.
  const id = modelId.slice(0, 200).toLowerCase()
  if (!id) return 'other'
  for (const [re, family] of MODEL_FAMILY_PATTERNS) if (re.test(id)) return family
  return 'other'
}

/**
 * How a turn ended.
 *
 * `stopped` is split out from `error` because conflating them destroys the one
 * signal that matters most: a user pressing Stop is usually the agent going off
 * the rails, which is a PRODUCT failure, while an error is typically a provider
 * or network failure. A single `ok: false` boolean reports both as "a turn
 * failed" and leaves us unable to tell a bad agent from a bad afternoon at
 * Anthropic.
 */
export type TurnOutcome = 'ok' | 'stopped' | 'error'

/**
 * Why a turn failed, from a fixed set.
 *
 * NEVER the error message. Provider error text routinely embeds the request
 * URL (a private gateway), an account id, a file path, or a partial API key,
 * and it is unbounded and unpredictable. The kind is what actually drives a
 * decision - a spike in `billing` means people are hitting credit walls, a
 * spike in `rate_limit` means we should back off harder - and the message adds
 * nothing to that while carrying every risk.
 */
export type TurnErrorKind =
  /** 429 / explicit rate-limit. Provider is throttling us. */
  | 'rate_limit'
  /** Out of credits, quota exhausted, payment required. The user must act. */
  | 'billing'
  /** 401/403, revoked token, provider not connected. */
  | 'auth'
  /** Dropped socket, DNS, refused connection, timeout. */
  | 'network'
  /** Conversation exceeded the model's context window. */
  | 'context_overflow'
  /** Provider 5xx. Their fault, not ours. */
  | 'provider_error'
  /** 400-class: we sent something the provider rejected. Usually OUR bug. */
  | 'bad_request'
  /** Classified as nothing else. A rising share here means this list needs a row. */
  | 'unknown'

/**
 * Phrases that mean "the account is out of money", across providers that
 * disagree wildly about status codes: OpenAI returns 429 `insufficient_quota`,
 * Anthropic a 400 "credit balance is too low", others a 402.
 *
 * Deliberately narrow, and checked BEFORE rate limits, so a plain
 * "rate limit reached, try again in 2s" stays a rate limit. Mirrors the
 * harness's own retry classifier (`QUOTA_BILLING_RE` in main/harness/agent.ts)
 * because the two answer the same question and must not disagree.
 */
const BILLING_RE =
  /insufficient[_ ]?quota|exceeded your current quota|check your plan and billing|billing[_ ]?hard[_ ]?limit|hard limit (?:has been |was )?reached|out of credits|credit balance is too low|insufficient[_ ]?credits?|not enough credits|no credits (?:remaining|left)|purchase (?:more )?credits|add a payment method|payment required|billing details/i

const CONTEXT_RE =
  /context[_ ]?length[_ ]?exceeded|maximum context length|context window|too many tokens|prompt is too long|reduce the length of the messages|input length and `max_tokens` exceed/i

const AUTH_RE =
  /unauthorized|forbidden|invalid[_ ]api[_ ]?key|incorrect api key|authentication|invalid[_ ]?token|expired[_ ]?token|not connected|no credential|permission denied/i

const RATE_LIMIT_RE = /rate[_ ]?limit|too many requests|overloaded|capacity|try again in/i

const NETWORK_RE =
  /fetch failed|socket hang ?up|network (?:error|timeout)|terminated|other side closed|premature close|stream (?:closed|error|aborted)|connection (?:closed|reset|refused|error)|timed? ?out|econnreset|econnrefused|enotfound|eai_again|und_err/i

/**
 * Classify a turn failure from its HTTP status and message text.
 *
 * Pure and text-in/enum-out so the whole matrix is testable without Electron,
 * a provider, or a network. The caller (main/services/turn-metrics.ts) is
 * responsible for extracting the two inputs from whatever error object the
 * transport threw; keeping that extraction OUT of here is what lets this file
 * stay dependency-free.
 *
 * Order matters and is not the same as the status order:
 *  1. Billing first, because it arrives as a 429 and a 400 and a 402 and only
 *     the TEXT distinguishes it from an ordinary throttle.
 *  2. Context overflow next, because it arrives as a 400 and would otherwise be
 *     filed as our bug when it is really a conversation that grew too long.
 *  3. Then status codes, which are reliable once the ambiguous cases are gone.
 */
export function classifyTurnError(
  status: number | undefined,
  text: string | undefined
): TurnErrorKind {
  // Bounded for the same reason as the model id: this is unbounded provider
  // output being fed to a regex.
  const t = typeof text === 'string' ? text.slice(0, 2000) : ''

  if (BILLING_RE.test(t)) return 'billing'
  if (CONTEXT_RE.test(t)) return 'context_overflow'

  if (typeof status === 'number' && status > 0) {
    if (status === 402) return 'billing'
    if (status === 401 || status === 403) return 'auth'
    if (status === 429) return 'rate_limit'
    if (status === 408) return 'network'
    if (status >= 500) return 'provider_error'
    if (status >= 400) {
      // A 400 whose text names an auth problem is an auth problem; providers
      // are not consistent about which of the two codes they use.
      if (AUTH_RE.test(t)) return 'auth'
      return 'bad_request'
    }
  }

  // No usable status: fall back to the text. Network last, because its pattern
  // is the broadest and would otherwise swallow more specific kinds.
  if (AUTH_RE.test(t)) return 'auth'
  if (RATE_LIMIT_RE.test(t)) return 'rate_limit'
  if (NETWORK_RE.test(t)) return 'network'
  return 'unknown'
}

/**
 * One-time-per-install milestones, reported in order.
 *
 * This is the activation funnel, and it is the metric an early-stage product
 * most often lacks: installs are easy to count and mean almost nothing, while
 * "installed, connected a provider, sent a prompt, got a working answer" is the
 * chain that says whether the thing actually onboards anyone. Each step is
 * reported at most once ever (see `markActivation` in main/services/track.ts),
 * so the counts are directly comparable as a funnel rather than being dominated
 * by whoever opened the app most times.
 */
export type ActivationMilestone =
  /** A provider was connected for the first time. Without this nothing can run. */
  | 'provider_connected'
  /** The first prompt was submitted. */
  | 'first_prompt'
  /** The first turn that actually completed. The real "it worked" moment. */
  | 'first_turn_ok'

export const ACTIVATION_MILESTONES: ActivationMilestone[] = [
  'provider_connected',
  'first_prompt',
  'first_turn_ok'
]

/**
 * Capability surfaces worth counting, as a closed set.
 *
 * These answer "what is Roxy actually FOR", which drives what we build next.
 * An agent that people only ever use to read files is a different product from
 * one people run overnight with subagents and MCP servers, and the difference
 * is invisible in DAU.
 *
 * Reported at most once per session per feature, so one enthusiastic user
 * cannot manufacture a trend.
 */
export type FeatureId =
  /** Paired with a phone (Remote Workspace). */
  | 'remote_pair'
  /** An MCP server was connected during a turn. */
  | 'mcp_server'
  /** A SKILL.md was loaded. */
  | 'skill'
  /** The agent delegated to a subagent via `task`. */
  | 'subagent'
  /** A detached background task was started. */
  | 'background_task'
  /** A session ran in its own git worktree/workstream. */
  | 'worktree'
  /** The built-in browser was driven. */
  | 'browser'
  /** A scheduled loop was created. */
  | 'loop'
  /** The conversation was auto-compacted. */
  | 'compaction'
  /** A session was forked. */
  | 'fork'
  /** Plan mode (read-only agent) was used. */
  | 'plan_mode'

export const FEATURE_IDS: FeatureId[] = [
  'remote_pair',
  'mcp_server',
  'skill',
  'subagent',
  'background_task',
  'worktree',
  'browser',
  'loop',
  'compaction',
  'fork',
  'plan_mode'
]

const FEATURE_SET = new Set<string>(FEATURE_IDS)

/** Whether an id is a known feature surface (guards the tracking call). */
export function isFeatureId(v: string): v is FeatureId {
  return FEATURE_SET.has(v)
}

/**
 * Tool names safe to report, and the rule for everything else.
 *
 * The built-in catalog is public and fixed, so those names carry no
 * information about a user. Two categories are NOT safe and are collapsed:
 *
 *  - **MCP tools** arrive as `mcp__<serverId>__<toolName>`, where `serverId` is
 *    whatever the user called their server. `mcp__acme_internal_billing__query`
 *    would publish a company's internal service names to a public stats page.
 *    Every MCP tool reports as the single token `mcp`.
 *  - **Skills** are user-authored markdown; the name is theirs, not ours.
 *    Reports as `skill`.
 *
 * Kept as an explicit list rather than derived from `TOOLS` so that adding a
 * tool to the catalog is not silently also a decision to publish its name -
 * the two are different calls, and this one deserves to be deliberate.
 */
const REPORTABLE_TOOLS = new Set<string>([
  // Files & search
  'read',
  'write',
  'edit',
  'list',
  'glob',
  'grep',
  // Shell
  'bash',
  'bash_list',
  'bash_output',
  'bash_kill',
  // Web
  'webfetch',
  'websearch',
  // Browser
  'browser_open',
  'browser_screenshot',
  'browser_read',
  'browser_console',
  'browser_click',
  'browser_scroll',
  'browser_type',
  'browser_tabs',
  'browser_new_tab',
  'browser_activate_tab',
  'browser_close',
  // Automation
  'loop_create',
  'loop_remove',
  'loop_list',
  'loop_enable',
  'loop_disable',
  'change_session_metadata',
  // Agents
  'task',
  'lsp',
  // Offered to the model but absent from the user-facing catalog.
  'mcp',
  'skill',
  'skill_manage'
])

/**
 * Collapse a tool name to something safe to report.
 *
 * Total: any string returns either a built-in name or one of `mcp` / `other`.
 * An MCP tool is detected by prefix rather than by asking the registry, so this
 * stays pure and cannot be defeated by a server that connects later.
 */
export function reportableToolName(name: string | null | undefined): string {
  if (typeof name !== 'string') return 'other'
  const n = name.slice(0, 80)
  // Prefix check first: `mcp__foo__bar` must never fall through to a lookup
  // that might one day contain it.
  if (n.startsWith('mcp__')) return 'mcp'
  if (REPORTABLE_TOOLS.has(n)) return n
  return 'other'
}

/**
 * Agent modes we report. `build` and `plan` are the shipped primaries; a
 * subagent type is reported as `subagent` rather than by name so a future
 * custom-agent feature can't leak user-chosen names through this field.
 */
export type AgentMode = 'build' | 'plan' | 'subagent' | 'other'

export function reportableAgent(agentId: string | null | undefined): AgentMode {
  if (agentId === 'build' || agentId === 'plan') return agentId
  if (agentId === 'general' || agentId === 'explore' || agentId === 'compaction') return 'subagent'
  return 'other'
}

/**
 * Bucket a count into a small ordinal label.
 *
 * Used for the "how deep did this turn go" dimensions. A raw count is fine on
 * its own, but the bucketed form is what makes a distribution chartable without
 * shipping a histogram, and it is what makes the headline claim legible: "62%
 * of turns run 5+ agent steps" is a sentence about a product, where "mean steps
 * 6.4" is a sentence about a mean, and means lie about long-tailed
 * distributions.
 */
export type CountBucket = '0' | '1' | '2-4' | '5-9' | '10-24' | '25+'

export function bucketCount(n: number): CountBucket {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n === 1) return '1'
  if (n < 5) return '2-4'
  if (n < 10) return '5-9'
  if (n < 25) return '10-24'
  return '25+'
}

/**
 * Round a USD amount to a sane precision for aggregation.
 *
 * Six decimals: a single cheap turn can genuinely cost $0.0001, and truncating
 * that to two decimals would report the entire cheap-model segment as free.
 * Bounded above because this is summed across a fleet and a garbage price in
 * the catalog should not be able to produce an absurd headline.
 */
export function roundUsd(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0
  return Math.round(Math.min(v, 1000) * 1e6) / 1e6
}

/**
 * Clamp a token count to a plausible range.
 *
 * Mirrors the server's own validator so a broken counter is caught before it
 * leaves the machine, rather than being silently dropped at ingest where we'd
 * never know it happened. Non-integers, negatives and absurd values report as
 * 0 rather than being clamped to the ceiling: a wrong number that looks
 * plausible is worse than no number.
 */
export function safeTokens(v: number | null | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  if (!Number.isInteger(v) || v < 0 || v > 100_000_000) return 0
  return v
}
