import type { McpServerView, SkillView } from './api'

/** Public relay contract. Upstream credentials never cross the desktop bridge. */
export type CatalogKind = 'skills' | 'mcp'
export interface CatalogEntry {
  id: string
  kind: CatalogKind
  name: string
  description: string
  source: string
  url: string | null
  iconUrl: string | null
  /** Null when the upstream does not publish install counts (not zero). */
  installs: number | null
  version: string | null
}
export interface CatalogSearchResult {
  entries: CatalogEntry[]
  nextCursor: string | null
  stale: boolean
  updatedAt: string
}
export interface CatalogSkillDetail {
  /** Desktop-local immutable review handle, not an upstream token. */
  reviewId: string
  entry: CatalogEntry
  hash: string | null
  files: { path: string; contents: string }[] | null
}
export interface RegistryInput {
  name?: string
  valueHint?: string
  type?: 'named' | 'positional'
  value?: string
  default?: string
  description?: string
  placeholder?: string
  isRequired?: boolean
  isSecret?: boolean
  isRepeated?: boolean
  choices?: string[]
  variables?: Record<string, RegistryInput>
}
export interface RegistryMcpServer {
  name: string
  title?: string
  description: string
  version: string
  websiteUrl?: string
  repository?: { url: string; source?: string }
  icons?: { src: string; mimeType?: string; theme?: string }[]
  remotes?: {
    type: string
    url: string
    headers?: RegistryInput[]
    variables?: Record<string, RegistryInput>
  }[]
  packages?: {
    registryType: string
    identifier: string
    version?: string
    registryBaseUrl?: string
    runtimeHint?: string
    fileSha256?: string
    transport: { type: string; url?: string }
    environmentVariables?: RegistryInput[]
    runtimeArguments?: RegistryInput[]
    packageArguments?: RegistryInput[]
  }[]
}
export interface CatalogMcpDetail {
  entry: CatalogEntry
  server: RegistryMcpServer
}
export interface CatalogField {
  key: string
  label: string
  description?: string
  placeholder?: string
  required: boolean
  secret: boolean
  default?: string
  choices?: string[]
}
export interface CatalogMcpOption {
  id: string
  label: string
  fields: CatalogField[]
  /** Review only. Main reconstructs the install config from the manifest. */
  preview: string
}
export interface CatalogMcpSetup {
  reviewId: string
  entry: CatalogEntry
  options: CatalogMcpOption[]
}
export interface CatalogApi {
  search(kind: CatalogKind, query: string, cursor?: string): Promise<CatalogSearchResult>
  skillDetail(id: string): Promise<CatalogSkillDetail>
  installSkill(id: string, reviewId: string): Promise<SkillView[]>
  mcpSetup(id: string): Promise<CatalogMcpSetup>
  installMcp(input: {
    id: string
    reviewId: string
    optionId: string
    values: Record<string, string>
  }): Promise<McpServerView[]>
}
