/**
 * The Marketplace: one catalog, one noun, one place.
 *
 * ## Why this module exists
 *
 * Roxy grew four *separate* ways to extend it, each with its own page and its own
 * vocabulary:
 *
 *  - **Skills** (`/skills`) — `SKILL.md` playbooks discovered on disk.
 *  - **MCP servers** (`/mcp`) — external tool servers over stdio/HTTP.
 *  - **Integrations** (`/integrations`) — messaging surfaces (Telegram, Slack…).
 *  - **Remote Workspace** (a dialog in the sidebar) — bridge the session to a phone.
 *
 * Four doors to the same question — *"what else can Roxy do?"* — is three doors too
 * many. A user who wants Roxy to read their Postgres has to already know the words
 * "MCP server"; a user who wants a reusable release-notes workflow has to already
 * know the words "SKILL.md frontmatter". That is a *mechanism-first* UI, and
 * mechanism-first UIs are only intuitive to the person who built them.
 *
 * ## The model
 *
 * Everything above is the same shape: **a capability you can turn on, that grants
 * Roxy some power, that you can turn off again.** So there is exactly one noun —
 * an **Add-on** — with a `kind` that says which machinery implements it. The kind
 * is a *badge*, not a section: it explains, it doesn't organize.
 *
 * What we keep from VS Code's marketplace:
 *   search-first, Installed vs Discover, one-click install, a detail view,
 *   enable/disable without uninstalling, categories as filters.
 *
 * What we deliberately drop:
 *   publisher accounts, a hosted registry, version pinning + update campaigns,
 *   ratings/reviews, per-extension sidebar views. None of that helps a single user
 *   answer "what else can Roxy do?", and all of it is surface to maintain.
 *
 * What we keep from Claude Code / agent CLIs:
 *   the artifact is a plain file you own and can read, capabilities are legible,
 *   and the agent itself can install/toggle add-ons through the same API the UI uses.
 *
 * ## The rule that makes it trustworthy
 *
 * Every add-on declares its {@link CapabilityId}s up front, and an add-on's risk is
 * *derived* from them (see {@link addonRisk}) rather than self-reported — so nothing
 * can advertise itself as harmless while asking for the keys to the machine. The UI
 * shows those chips on the card, before install, which is the whole reason
 * something like {@link SUPERUSER_ADDON} can exist in the list at all.
 *
 * Pure + dependency-free (no Node, no Electron), so it's unit-tested in
 * `npm run smoke:shared` alongside the other shared catalogs.
 */

import type { McpServerConfig } from './mcp'

// ===========================================================================
// Capabilities — the permission vocabulary
// ===========================================================================

/**
 * A single power an add-on can ask for. This is the *user-facing* permission
 * vocabulary: deliberately coarse (11 buckets, not 60 scopes) because a list of
 * permissions nobody reads is worse than four chips everybody does.
 */
export type CapabilityId =
  | 'files-read'
  | 'files-write'
  | 'shell'
  | 'network'
  | 'browser'
  | 'screen'
  | 'input-control'
  | 'apps'
  | 'credentials'
  | 'messaging'
  | 'always-on'

/**
 * How much damage a capability can do if the add-on behind it is buggy or hostile.
 * Ordered; {@link addonRisk} takes the max over an add-on's capabilities.
 */
export type RiskLevel = 'safe' | 'moderate' | 'elevated' | 'critical'

/** Ascending severity, so risk can be compared/maxed numerically. */
export const RISK_ORDER: RiskLevel[] = ['safe', 'moderate', 'elevated', 'critical']

export interface CapabilityDef {
  id: CapabilityId
  /** Chip text. Plain language, no jargon — a verb phrase where possible. */
  label: string
  /** One line explaining the real-world consequence, shown on hover/detail. */
  detail: string
  risk: RiskLevel
  /** lucide-react icon name, resolved by the renderer's icon map. */
  icon: string
}

export const CAPABILITIES: CapabilityDef[] = [
  {
    id: 'files-read',
    label: 'Read files',
    detail: 'Can read files in the workspace it was given.',
    risk: 'safe',
    icon: 'file-text'
  },
  {
    id: 'files-write',
    label: 'Change files',
    detail: 'Can create, edit and delete files in the workspace.',
    risk: 'moderate',
    icon: 'file-pen'
  },
  {
    id: 'network',
    label: 'Network access',
    detail: 'Can send data to, and fetch data from, the internet.',
    risk: 'moderate',
    icon: 'globe'
  },
  {
    id: 'browser',
    label: 'Drive a browser',
    detail: 'Can open pages, click and type in a real browser session.',
    risk: 'moderate',
    icon: 'globe'
  },
  {
    id: 'messaging',
    label: 'Send messages',
    detail: 'Can read and send messages on your behalf in a chat app.',
    risk: 'elevated',
    icon: 'message-circle'
  },
  {
    id: 'credentials',
    label: 'Use secrets',
    detail: 'Holds API keys or tokens you provide; they are stored on this machine.',
    risk: 'elevated',
    icon: 'shield'
  },
  {
    id: 'always-on',
    label: 'Runs in background',
    detail: 'Keeps running between turns, even when you are not looking at Roxy.',
    risk: 'elevated',
    icon: 'timer'
  },
  {
    id: 'shell',
    label: 'Run commands',
    detail: 'Can execute shell commands on this computer.',
    risk: 'elevated',
    icon: 'terminal'
  },
  {
    id: 'screen',
    label: 'See your screen',
    detail: 'Can capture what is on your display, including other apps.',
    risk: 'critical',
    icon: 'monitor'
  },
  {
    id: 'input-control',
    label: 'Control mouse & keyboard',
    detail: 'Can move the pointer and type as if it were you. Nothing is off-limits.',
    risk: 'critical',
    icon: 'mouse-pointer'
  },
  {
    id: 'apps',
    label: 'Control other apps',
    detail: 'Can launch, script and quit applications outside Roxy.',
    risk: 'critical',
    icon: 'layout-grid'
  }
]

const CAPABILITY_BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]))

export function getCapability(id: CapabilityId): CapabilityDef | undefined {
  return CAPABILITY_BY_ID.get(id)
}

/** Compare two risk levels the way `Array#sort` wants (ascending severity). */
export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  return RISK_ORDER.indexOf(a) - RISK_ORDER.indexOf(b)
}

/**
 * An add-on's risk is the **worst** of the capabilities it asks for — computed,
 * never declared. An add-on cannot claim to be safe while asking to drive your
 * keyboard, which is precisely the lie a marketplace has to make impossible.
 */
export function addonRisk(capabilities: CapabilityId[]): RiskLevel {
  let worst: RiskLevel = 'safe'
  for (const id of capabilities) {
    const cap = CAPABILITY_BY_ID.get(id)
    if (cap && compareRisk(cap.risk, worst) > 0) worst = cap.risk
  }
  return worst
}

/**
 * Whether turning this on should demand an explicit, typed confirmation rather
 * than a switch flip. `critical` means "can act as you, outside Roxy" — a toggle
 * is too cheap a gesture for that.
 */
export function needsConsent(capabilities: CapabilityId[]): boolean {
  return addonRisk(capabilities) === 'critical'
}

/** Capability chips, worst-first — the scary ones must not be below the fold. */
export function sortCapabilities(capabilities: CapabilityId[]): CapabilityDef[] {
  return capabilities
    .map((id) => CAPABILITY_BY_ID.get(id))
    .filter((c): c is CapabilityDef => !!c)
    .sort((a, b) => compareRisk(b.risk, a.risk) || a.label.localeCompare(b.label))
}

// ===========================================================================
// Add-ons — the single noun
// ===========================================================================

/**
 * Which machinery implements an add-on. Shown as a badge so the mechanism stays
 * discoverable ("ah, that one is an MCP server") without being the way the list
 * is organized.
 */
export type AddonKind = 'skill' | 'mcp' | 'integration' | 'bridge' | 'system' | 'lab'

export interface AddonKindDef {
  id: AddonKind
  /** Badge text. */
  label: string
  /** One line for the detail panel: what this kind of add-on *is*. */
  detail: string
  icon: string
}

export const ADDON_KINDS: AddonKindDef[] = [
  {
    id: 'skill',
    label: 'Skill',
    detail: 'A SKILL.md playbook. Roxy loads its instructions when a task matches.',
    icon: 'file-text'
  },
  {
    id: 'mcp',
    label: 'Tool server',
    detail: 'An MCP server that hands Roxy new tools, over stdio or HTTP.',
    icon: 'plug'
  },
  {
    id: 'integration',
    label: 'Channel',
    detail: 'A place you can talk to Roxy from, outside this app.',
    icon: 'message-circle'
  },
  {
    id: 'bridge',
    label: 'Bridge',
    detail: 'Connects this workspace to another device you own.',
    icon: 'monitor-smartphone'
  },
  {
    id: 'system',
    label: 'System',
    detail: 'Reaches outside the workspace and operates this computer directly.',
    icon: 'cpu'
  },
  {
    id: 'lab',
    label: 'Lab',
    detail: 'An idea being explored in the repo. Flip it on to try it early.',
    icon: 'flask-conical'
  }
]

const KIND_BY_ID = new Map(ADDON_KINDS.map((k) => [k.id, k]))

export function getAddonKind(id: AddonKind): AddonKindDef | undefined {
  return KIND_BY_ID.get(id)
}

/**
 * Categories are the *only* taxonomy in the UI besides search. Kept to seven so
 * the filter row never wraps and never needs a "More…" — a category list you
 * scroll is a category list that has stopped helping.
 */
export type AddonCategory =
  | 'Coding'
  | 'Data'
  | 'Web'
  | 'Communication'
  | 'Devices'
  | 'System'
  | 'Workflow'

export const ADDON_CATEGORIES: AddonCategory[] = [
  'Coding',
  'Data',
  'Web',
  'Communication',
  'Devices',
  'System',
  'Workflow'
]

/**
 * Lifecycle of an add-on *as the user experiences it*. Deliberately not the union
 * of every backend status: an MCP connection error and a skill whose file vanished
 * are both `broken` here, because the user's next move is the same either way.
 */
export type AddonState =
  | 'enabled' // installed and on
  | 'disabled' // installed but off
  | 'available' // in the catalog, not installed
  | 'preview' // shipped as a shell — visible, honest, does nothing yet
  | 'planned' // an idea in Labs, not built
  | 'broken' // installed but failing (bad config, missing file, dead server)

/**
 * A catalog entry: everything needed to render a card and a detail panel, with no
 * knowledge of whether it happens to be installed. Live state is merged in at the
 * renderer (see `AddonRow` in the Marketplace route).
 */
export interface AddonManifest {
  /** Stable id. For catalog entries this is also the on-disk / server name. */
  id: string
  name: string
  /** One line, capability-first: what Roxy can *do* with this. No jargon. */
  tagline: string
  kind: AddonKind
  category: AddonCategory
  capabilities: CapabilityId[]
  /** Only for entries that ship as a shell (`preview`) or an idea (`planned`). */
  state?: Extract<AddonState, 'preview' | 'planned'>
  icon: string
  /** Who publishes it — "Roxy" for built-ins, else an upstream owner. */
  author?: string
  /** Docs/homepage. Opened externally; never rendered as HTML. */
  homepage?: string
  /** Search keywords beyond name/tagline (aliases, the jargon we hid). */
  keywords?: string[]
  /** Recipe for one-click install. Absent = nothing to install (shells, ideas). */
  install?: AddonInstall
  /**
   * Longer prose for the detail panel: what it does, what it costs you, what it
   * cannot do. Rendered as paragraphs, not markdown.
   */
  about?: string[]
}

/** How "Install" is carried out — one branch per backing subsystem. */
export type AddonInstall =
  /** Write an MCP server entry, then connect it. */
  | {
      via: 'mcp'
      config: McpServerConfig
      /** Env/header/arg keys the user must fill in before it will run. */
      needs?: string[]
    }
  /** Fetch SKILL.md(s) from a GitHub repo / URL, exactly like `npx skills add`. */
  | { via: 'skill'; source: string }
  /** Flip a persisted flag (integrations table). Nothing to download. */
  | { via: 'flag' }

/**
 * Values the user must supply before an add-on can work (a token, a path, a
 * connection string). Only MCP installs can have them; this narrows the union in
 * one place so the UI can just ask "does this need setup?".
 *
 * Driving the install button off this is what stops one-click from meaning
 * "one click, then a broken server and a debugging session".
 */
export function installNeeds(install: AddonInstall | undefined): string[] {
  return install?.via === 'mcp' ? (install.needs ?? []) : []
}

// ===========================================================================
// Persisted flags — how `preview` and `lab` add-ons remember their switch
// ===========================================================================

/**
 * Labs flags and shell add-ons persist through the existing `integrations` table
 * (a plain `id → enabled + config` store) under a namespaced id, so this whole
 * feature needs no migration and no new IPC channel: `integrations.list()` and
 * `integrations.setEnabled()` already do exactly this job. The Integrations page
 * renders only ids from its own catalog, so the namespaced rows stay invisible
 * there instead of leaking in as ghost entries.
 */
export const LAB_FLAG_PREFIX = 'lab:'
export const ADDON_FLAG_PREFIX = 'addon:'

export function labFlagId(id: string): string {
  return LAB_FLAG_PREFIX + id
}

export function addonFlagId(id: string): string {
  return ADDON_FLAG_PREFIX + id
}

/** Read one namespaced flag out of the rows `integrations.list()` returned. */
export function readFlag(rows: { id: string; enabled: boolean }[], flagId: string): boolean {
  return rows.some((r) => r.id === flagId && r.enabled)
}

// ===========================================================================
// The SuperUser add-on — a shell, on purpose
// ===========================================================================

/**
 * **SuperUser** — the first add-on of its kind, and a deliberate shell: it is
 * listed, it is describable, it asks for consent, and it does *nothing*.
 *
 * It exists in this state for two reasons.
 *
 * 1. It is the honest way to design the dangerous end of the marketplace. Full
 *    machine control is the capability everything else is measured against; if the
 *    permission model, the consent gate and the detail panel can hold *this*
 *    without lying to the user, they can hold anything milder. Building the UI
 *    against a real `critical` entry — rather than a hypothetical one — is what
 *    keeps {@link addonRisk} and {@link needsConsent} from being decoration.
 *
 * 2. Shipping the shell before the engine means the scary part is reviewed in
 *    daylight. Every capability it will eventually need is already written down
 *    below, so the conversation about whether Roxy should be allowed to do this
 *    happens *now*, over a manifest, instead of later, over an implementation.
 *
 * `state: 'preview'` is load-bearing: the UI must render it as "not implemented",
 * never as "off". A switch that looks live but is inert is the one failure mode
 * this add-on cannot have.
 */
export const SUPERUSER_ADDON: AddonManifest = {
  id: 'superuser',
  name: 'SuperUser',
  tagline: 'Let Roxy operate this whole computer, not just the workspace.',
  kind: 'system',
  category: 'System',
  capabilities: [
    'input-control',
    'screen',
    'apps',
    'shell',
    'files-read',
    'files-write',
    'network'
  ],
  state: 'preview',
  icon: 'cpu',
  author: 'Roxy',
  keywords: ['computer use', 'automation', 'os', 'desktop', 'root', 'admin', 'accessibility'],
  about: [
    'Today Roxy acts inside a workspace: it reads and writes files in a folder, runs commands there, and drives its own browser. SuperUser is the proposal to lift that boundary — one add-on that lets Roxy use the machine the way you do.',
    'That means moving the real pointer, typing into whatever app has focus, reading the screen to see the result, and launching or quitting programs. Not a bigger sandbox: no sandbox.',
    'It is shipped here as a shell. Nothing is wired to the agent, the switch grants no permission, and turning it on changes no behaviour. What you are looking at is the manifest — the exact list of powers it would need — published before the code exists, so the trade is reviewable while it is still cheap to change.',
    'When it is built it will stay opt-in per session, ask before each new class of action, keep a reviewable log of everything it did, and be revocable from one place. If it cannot do all four, it should not ship.'
  ]
}

// ===========================================================================
// Discover — the curated catalog
// ===========================================================================

/**
 * The one-click catalog. Small on purpose: a curated dozen that covers the common
 * asks beats a searchable thousand nobody can judge, and every entry here is
 * something a maintainer has actually run. Growth belongs in "Add manually",
 * which accepts any MCP server or any skill repo — the catalog is a shortcut,
 * never the boundary of what is possible.
 */
export const MARKETPLACE_CATALOG: AddonManifest[] = [
  // ---- Coding -------------------------------------------------------------
  {
    id: 'github',
    name: 'GitHub',
    tagline: 'Read and manage repos, issues and pull requests.',
    kind: 'mcp',
    category: 'Coding',
    capabilities: ['network', 'credentials'],
    icon: 'git-branch',
    author: 'GitHub',
    homepage: 'https://github.com/github/github-mcp-server',
    keywords: ['mcp', 'git', 'pr', 'issues', 'review'],
    install: {
      via: 'mcp',
      config: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-github'],
        environment: { GITHUB_PERSONAL_ACCESS_TOKEN: '' }
      },
      needs: ['GITHUB_PERSONAL_ACCESS_TOKEN']
    },
    about: [
      'Gives Roxy the GitHub API as tools: search code, open and review pull requests, triage issues, read Actions runs.',
      'Needs a personal access token. It is stored on this machine and sent only to GitHub.'
    ]
  },
  {
    id: 'filesystem',
    name: 'Filesystem (extra folders)',
    tagline: 'Let Roxy reach a folder outside the current workspace.',
    kind: 'mcp',
    category: 'Coding',
    capabilities: ['files-read', 'files-write'],
    icon: 'folder',
    author: 'Model Context Protocol',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    keywords: ['mcp', 'files', 'directory', 'notes'],
    install: {
      via: 'mcp',
      config: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', ''],
        environment: {}
      },
      needs: ['path']
    },
    about: [
      'Roxy already has full access to the workspace it is pointed at. This is for the second folder — a notes vault, a design export, a sibling repo you keep referring to.',
      'Scoped to the paths you list, and nothing above them.'
    ]
  },
  {
    id: 'code-review',
    name: 'Code Review',
    tagline: 'A review pass with your team’s standards, not generic advice.',
    kind: 'skill',
    category: 'Coding',
    capabilities: ['files-read'],
    icon: 'file-text',
    author: 'Roxy',
    keywords: ['skill', 'review', 'lint', 'standards', 'pr'],
    install: { via: 'skill', source: 'roxy-gg/skills/code-review' },
    about: [
      'A SKILL.md that tells Roxy how to review a diff: what to flag, what to leave alone, and in what order to report.',
      'It is a text file under ~/.roxy/skills — edit it until the reviews sound like your team.'
    ]
  },
  // ---- Data ---------------------------------------------------------------
  {
    id: 'postgres',
    name: 'Postgres',
    tagline: 'Explore a database and answer questions with real SQL.',
    kind: 'mcp',
    category: 'Data',
    capabilities: ['network', 'credentials'],
    icon: 'database',
    author: 'Model Context Protocol',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    keywords: ['mcp', 'sql', 'database', 'schema', 'query'],
    install: {
      via: 'mcp',
      config: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-postgres', ''],
        environment: {}
      },
      needs: ['connection string']
    },
    about: [
      'Roxy can read the schema and run queries, so "why is this migration slow" gets answered against your data instead of guessed from the code.',
      'Point it at a read-only replica or a read-only role. It will run whatever SQL it decides it needs.'
    ]
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    tagline: 'Query a local .db file directly.',
    kind: 'mcp',
    category: 'Data',
    capabilities: ['files-read', 'files-write'],
    icon: 'database',
    author: 'Model Context Protocol',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    keywords: ['mcp', 'sql', 'database', 'local'],
    install: {
      via: 'mcp',
      config: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-sqlite', '--db-path', ''],
        environment: {}
      },
      needs: ['--db-path']
    }
  },
  // ---- Web ----------------------------------------------------------------
  {
    id: 'playwright',
    name: 'Playwright',
    tagline: 'Test and script a real browser, headless.',
    kind: 'mcp',
    category: 'Web',
    capabilities: ['browser', 'network', 'shell'],
    icon: 'globe',
    author: 'Microsoft',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    keywords: ['mcp', 'browser', 'e2e', 'test', 'scrape', 'automation'],
    install: {
      via: 'mcp',
      config: { type: 'local', command: ['npx', '-y', '@playwright/mcp@latest'] }
    },
    about: [
      'Roxy has a built-in browser for looking at pages. This is the other job: driving a scripted, headless browser to write and run end-to-end tests.',
      'It downloads browser binaries on first run.'
    ]
  },
  {
    id: 'fetch',
    name: 'Fetch',
    tagline: 'Pull any URL down as clean, readable text.',
    kind: 'mcp',
    category: 'Web',
    capabilities: ['network'],
    icon: 'globe',
    author: 'Model Context Protocol',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    keywords: ['mcp', 'http', 'scrape', 'markdown', 'docs'],
    install: {
      via: 'mcp',
      config: { type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-fetch'] }
    }
  },
  // ---- Workflow -----------------------------------------------------------
  {
    id: 'memory',
    name: 'Memory',
    tagline: 'Remember decisions and preferences across sessions.',
    kind: 'mcp',
    category: 'Workflow',
    capabilities: ['files-read', 'files-write'],
    icon: 'brain',
    author: 'Model Context Protocol',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    keywords: ['mcp', 'memory', 'knowledge graph', 'context', 'notes'],
    install: {
      via: 'mcp',
      config: { type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-memory'] }
    },
    about: [
      'A small knowledge graph on disk that survives between sessions, so "we decided against that in March" stays true without you retyping it.'
    ]
  },
  {
    id: 'release-notes',
    name: 'Release Notes',
    tagline: 'Turn a range of commits into a changelog people read.',
    kind: 'skill',
    category: 'Workflow',
    capabilities: ['files-read', 'shell'],
    icon: 'file-text',
    author: 'Roxy',
    keywords: ['skill', 'changelog', 'git', 'release'],
    install: { via: 'skill', source: 'roxy-gg/skills/release-notes' }
  },
  {
    id: 'agent-skills',
    name: 'Agent Skills pack',
    tagline: 'A starter set of community playbooks, installed in one go.',
    kind: 'skill',
    category: 'Workflow',
    capabilities: ['files-read'],
    icon: 'library',
    author: 'vercel-labs',
    homepage: 'https://github.com/vercel-labs/agent-skills',
    keywords: ['skill', 'pack', 'bundle', 'community', 'starter'],
    install: { via: 'skill', source: 'vercel-labs/agent-skills' },
    about: [
      'Installs every SKILL.md it finds in the repo. They land as editable files under ~/.roxy/skills — keep the ones that fit, delete the rest.'
    ]
  }
]

// ===========================================================================
// Labs — ideas in the open, behind a switch
// ===========================================================================

/**
 * A candidate implementation, published *before* it is built.
 *
 * This is the mechanism the repo uses to argue about direction in public. An idea
 * with a manifest — name, capabilities, effort, what would have to be true — is
 * something you can agree or disagree with. The same idea in a backlog ticket is
 * something only the author can see. So they live here, in the product, in the
 * same list as the things that already work, with an honest `state`.
 *
 * The switch is real for `preview` entries (a persisted flag; the feature reads
 * it) and inert for `planned` ones (an interest signal, and nothing more). The UI
 * has to say which is which, every time — the moment a `planned` toggle *looks*
 * functional, this whole section becomes a lie.
 */
export interface LabIdea {
  id: string
  name: string
  /** One line: the outcome, not the implementation. */
  tagline: string
  category: AddonCategory
  capabilities: CapabilityId[]
  /** `preview` = shell exists behind the flag. `planned` = idea only. */
  state: Extract<AddonState, 'preview' | 'planned'>
  /** Rough build cost, for reading the list as a roadmap. */
  effort: 'small' | 'medium' | 'large'
  icon: string
  /** Why it is worth doing — the argument, in one or two sentences. */
  rationale: string
  /** What already exists in this repo that it would build on. */
  buildsOn?: string
  /** The honest objection: what makes it hard, risky, or possibly wrong. */
  tradeoff?: string
}

export const LAB_IDEAS: LabIdea[] = [
  {
    id: 'skill-from-session',
    name: 'Save this session as a skill',
    tagline: 'Turn a session that went well into a reusable playbook.',
    category: 'Workflow',
    capabilities: ['files-read', 'files-write'],
    state: 'planned',
    effort: 'small',
    icon: 'file-text',
    rationale:
      'The best skills are transcripts of work that already succeeded. Writing them by hand afterwards is the step everyone skips, so the knowledge stays in one closed session.',
    buildsOn: 'The `skill_manage` tool and the SKILL.md serializer already write skills.',
    tradeoff:
      'A summarized transcript is verbose and workspace-specific; it needs real editing before it generalizes.'
  },
  {
    id: 'voice-mode',
    name: 'Voice mode',
    tagline: 'Hold a key, talk, let Roxy work while you keep reading.',
    category: 'Workflow',
    capabilities: ['network'],
    state: 'planned',
    effort: 'medium',
    icon: 'mic',
    rationale:
      'Prompts are long and typing them is the slow part. Dictation fits how people actually describe a bug — rambling, with corrections.',
    tradeoff:
      'Local transcription is heavy; a cloud one sends your voice off the machine, which contradicts the privacy line everywhere else.'
  },
  {
    id: 'cost-guardrails',
    name: 'Cost guardrails',
    tagline: 'A hard budget per session, with an automatic downshift instead of a stop.',
    category: 'Workflow',
    capabilities: [],
    state: 'planned',
    effort: 'small',
    icon: 'timer',
    rationale:
      'Roxy already meters tokens and cost precisely. The missing half is acting on it: cap a session, drop to a cheaper model at 80%, and never surprise anyone with the bill.',
    buildsOn: 'The usage meter + per-turn cost accounting already track every request.'
  },
  {
    id: 'night-shift',
    name: 'Night shift',
    tagline: 'Queue the boring work, review a report in the morning.',
    category: 'Workflow',
    capabilities: ['files-write', 'shell', 'always-on'],
    state: 'planned',
    effort: 'medium',
    icon: 'timer',
    rationale:
      'Dependency bumps, flaky-test triage and lint sweeps do not need supervision — they need a diff to review. Loops can already run on a schedule; what is missing is a digest worth reading.',
    buildsOn: 'Scheduled loops + workstreams (each run isolated in its own worktree/branch).',
    tradeoff:
      'Unsupervised writes on a schedule is exactly how you wake up to a broken main branch. Needs worktree isolation to be mandatory, not default.'
  },
  {
    id: 'checkpoint-rewind',
    name: 'Rewind',
    tagline: 'Step back to how the repo looked before any turn.',
    category: 'Coding',
    capabilities: ['files-read', 'files-write'],
    state: 'planned',
    effort: 'medium',
    icon: 'history',
    rationale:
      'Undo is the feature that makes an agent safe to let run. A per-turn checkpoint turns "it broke something four steps ago" from an investigation into a click.',
    buildsOn: 'Every session already runs in a git worktree on its own branch.',
    tradeoff:
      'Cheap for tracked files; untracked artifacts and anything the agent did outside git are not covered, and a half-honest undo is worse than none.'
  },
  {
    id: 'semantic-index',
    name: 'Semantic code index',
    tagline: 'Find code by what it does, not by the words in it.',
    category: 'Coding',
    capabilities: ['files-read'],
    state: 'planned',
    effort: 'large',
    icon: 'search',
    rationale:
      'grep needs the right identifier. On an unfamiliar repo the first question is "where does auth happen", and that has no keyword.',
    tradeoff:
      'A local index means embedding the whole repo and keeping it fresh; a remote one means uploading the source. Both are real costs for a win grep often already gets.'
  },
  {
    id: 'self-healing-tests',
    name: 'Self-healing tests',
    tagline: 'Watch the suite, and fix what it breaks.',
    category: 'Coding',
    capabilities: ['files-write', 'shell', 'always-on'],
    state: 'planned',
    effort: 'medium',
    icon: 'flask-conical',
    rationale:
      'The tightest useful agent loop is edit → run → read failure → repeat, and it is the one thing an agent does better than a person: it never gets bored on attempt nine.',
    tradeoff:
      'Optimizing for a green suite teaches an agent to delete assertions. Needs the diff reviewed as the deliverable, not the passing run.'
  },
  {
    id: 'bash-jail',
    name: 'Sandboxed shell',
    tagline: 'Run commands with the blast radius spelled out.',
    category: 'System',
    capabilities: ['shell'],
    state: 'planned',
    effort: 'large',
    icon: 'shield',
    rationale:
      '`bash` is the tool people hesitate over, and the hesitation is correct. A declared profile — these paths, this network, no more — is what makes approving it a decision instead of a gamble.',
    tradeoff:
      'Three separate implementations (seatbelt, namespaces, a Windows story) and a hard truth: a jail tight enough to be safe breaks half the commands people need.'
  },
  {
    id: 'team-relay',
    name: 'Team relay',
    tagline: 'Hand a live session to a teammate, not a screenshot.',
    category: 'Devices',
    capabilities: ['network', 'always-on'],
    state: 'planned',
    effort: 'medium',
    icon: 'monitor-smartphone',
    rationale:
      'Remote Workspace already relays a session to another device over an encrypted link with a PIN. The same primitive, pointed at a colleague, replaces the pasted terminal log.',
    buildsOn: 'The Remote Workspace relay (room + guest token + PIN pairing).',
    tradeoff:
      'A teammate is not you: it needs per-guest read-only vs. can-prompt roles, which the phone flow never had to answer.'
  },
  {
    id: 'browser-to-skill',
    name: 'Record a browser flow as a skill',
    tagline: 'Click through it once; get a repeatable playbook.',
    category: 'Web',
    capabilities: ['browser', 'files-write'],
    state: 'planned',
    effort: 'medium',
    icon: 'mouse-pointer',
    rationale:
      'Describing a deploy dashboard in prose is slower and less accurate than doing it once with a recorder on.',
    buildsOn: 'The built-in browser tools (open, click, type, read) already produce a usable trace.'
  },
  {
    id: 'menubar-agent',
    name: 'Menu bar agent',
    tagline: 'Ask from anywhere, without finding the window.',
    category: 'Devices',
    capabilities: ['always-on'],
    state: 'planned',
    effort: 'small',
    icon: 'layout-grid',
    rationale:
      'Most prompts are one line. A global shortcut and a small input beat switching apps to a full IDE window.'
  },
  {
    id: 'local-models',
    name: 'Local model autodetect',
    tagline: 'Notice Ollama or LM Studio and offer it, without setup.',
    category: 'System',
    capabilities: ['network'],
    state: 'planned',
    effort: 'small',
    icon: 'cpu',
    rationale:
      'Both providers are already in the catalog, but only if you go and configure them. Probing the default port turns a config chore into a one-click offer — and makes the offline story real.',
    buildsOn: 'The Ollama + LM Studio provider entries already exist.'
  }
]

// ===========================================================================
// Search + filtering (pure, so the whole browse experience is testable)
// ===========================================================================

/** Anything renderable as a card. `installed`/`state` are merged in by the caller. */
export interface AddonSearchable {
  id: string
  name: string
  tagline: string
  kind: AddonKind
  category: AddonCategory
  keywords?: string[]
}

/**
 * Match a card against a query. Searches name, tagline, id, kind label and
 * keywords, so the jargon we removed from the UI still *finds* things: typing
 * "mcp" or "SKILL.md" works even though no card leads with either.
 *
 * All terms must match (AND), each anywhere in the haystack — the behaviour
 * people expect from an extension search box.
 */
export function matchesQuery(addon: AddonSearchable, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = [
    addon.name,
    addon.tagline,
    addon.id,
    addon.category,
    getAddonKind(addon.kind)?.label ?? '',
    ...(addon.keywords ?? [])
  ]
    .join(' ')
    .toLowerCase()
  return terms.every((t) => haystack.includes(t))
}

export interface AddonFilter {
  query?: string
  /** null/undefined = every category. */
  category?: AddonCategory | null
  /** null/undefined = every kind. */
  kind?: AddonKind | null
}

/** Whether one add-on survives the current search + chips. */
export function matchesFilter(addon: AddonSearchable, filter: AddonFilter): boolean {
  return (
    (!filter.category || addon.category === filter.category) &&
    (!filter.kind || addon.kind === filter.kind) &&
    matchesQuery(addon, filter.query ?? '')
  )
}

export function filterAddons<T extends AddonSearchable>(list: T[], filter: AddonFilter): T[] {
  return list.filter((a) => matchesFilter(a, filter))
}

/** Which categories are actually represented — so the filter row hides dead chips. */
export function categoriesPresent(list: AddonSearchable[]): AddonCategory[] {
  const present = new Set(list.map((a) => a.category))
  return ADDON_CATEGORIES.filter((c) => present.has(c))
}

/** "3 tools · reads files" style summary for a collapsed card. */
export function summarizeCapabilities(capabilities: CapabilityId[]): string {
  const caps = sortCapabilities(capabilities)
  if (!caps.length) return 'No extra permissions'
  if (caps.length <= 2) return caps.map((c) => c.label).join(' · ')
  return `${caps[0].label} · ${caps[1].label} +${caps.length - 2}`
}

const CATALOG_BY_ID = new Map(MARKETPLACE_CATALOG.map((a) => [a.id, a]))

/** Catalog lookup, used to enrich an installed row with its published manifest. */
export function getCatalogAddon(id: string): AddonManifest | undefined {
  return CATALOG_BY_ID.get(id)
}
