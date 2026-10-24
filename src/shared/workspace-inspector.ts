/** Project inspection and editing; paths are relative to a session-scoped root. */
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

export interface WorkspaceMedia {
  kind: 'image' | 'video' | 'audio' | 'pdf'
  mime: string
}

/** Only passive, browser-renderable formats; never serve workspace HTML or scripts. */
export function workspaceMedia(file: string): WorkspaceMedia | null {
  const extension = /\.([a-z0-9]+)$/i.exec(file)?.[1].toLowerCase()
  const formats: Record<string, WorkspaceMedia> = {
    png: { kind: 'image', mime: 'image/png' },
    apng: { kind: 'image', mime: 'image/apng' },
    jpg: { kind: 'image', mime: 'image/jpeg' },
    jpeg: { kind: 'image', mime: 'image/jpeg' },
    jfif: { kind: 'image', mime: 'image/jpeg' },
    gif: { kind: 'image', mime: 'image/gif' },
    webp: { kind: 'image', mime: 'image/webp' },
    avif: { kind: 'image', mime: 'image/avif' },
    bmp: { kind: 'image', mime: 'image/bmp' },
    ico: { kind: 'image', mime: 'image/x-icon' },
    svg: { kind: 'image', mime: 'image/svg+xml' },
    mp4: { kind: 'video', mime: 'video/mp4' },
    m4v: { kind: 'video', mime: 'video/mp4' },
    webm: { kind: 'video', mime: 'video/webm' },
    mov: { kind: 'video', mime: 'video/quicktime' },
    ogv: { kind: 'video', mime: 'video/ogg' },
    mp3: { kind: 'audio', mime: 'audio/mpeg' },
    wav: { kind: 'audio', mime: 'audio/wav' },
    ogg: { kind: 'audio', mime: 'audio/ogg' },
    oga: { kind: 'audio', mime: 'audio/ogg' },
    opus: { kind: 'audio', mime: 'audio/ogg' },
    m4a: { kind: 'audio', mime: 'audio/mp4' },
    aac: { kind: 'audio', mime: 'audio/aac' },
    flac: { kind: 'audio', mime: 'audio/flac' },
    pdf: { kind: 'pdf', mime: 'application/pdf' }
  }
  return extension && Object.hasOwn(formats, extension) ? formats[extension] : null
}

export interface WorkspaceInspectorApi {
  preview(
    sessionId: string,
    rootId: string,
    file: string
  ): Promise<InspectionResult<WorkspaceMedia & { url: string; size: number }>>
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
  ): Promise<InspectionResult<{ before: string; after: string; revision?: string }>>
  write(
    sessionId: string,
    rootId: string,
    file: string,
    content: string,
    expectedRevision: string
  ): Promise<InspectionResult<{ revision: string }> | { ok: false; reason: 'changed' }>
  confirmDiscard(message: string, discard: string, cancel: string): Promise<boolean>
}
