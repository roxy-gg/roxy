/** Read-only project inspection; paths are relative to a session-scoped root. */
export interface WorkspaceChange {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'conflict'
  additions: number | null
  deletions: number | null
}

export interface WorkspaceRoot {
  id: string
  name: string
  branch: string | null
  isRepo: boolean
  unavailable: boolean
  partial: boolean
  changes: WorkspaceChange[]
}

export interface WorkspaceSnapshot {
  roots: WorkspaceRoot[]
}

export interface WorkspaceEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'link'
}

export type InspectionResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: 'unavailable' | 'tooLarge' | 'binary' | 'unsafe' }

export interface WorkspaceInspectorApi {
  inspect(sessionId: string): Promise<WorkspaceSnapshot>
  list(
    sessionId: string,
    rootId: string,
    directory: string
  ): Promise<InspectionResult<{ entries: WorkspaceEntry[]; partial: boolean }>>
  read(
    sessionId: string,
    rootId: string,
    file: string,
    comparison: boolean
  ): Promise<InspectionResult<{ before: string; after: string }>>
}
