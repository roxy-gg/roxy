import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import {
  Download,
  FileText,
  FolderGit2,
  Home,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wrench
} from 'lucide-react'
import { TOOLS, TOOL_CATEGORIES, type ToolDef } from '@shared/tools'
import type { SkillView } from '@shared/api'
import { api } from '../lib/api'
import { Badge, Button, Input, Textarea } from '../components/ui'
import { PageShell } from '../components/PageShell'
import { ConfigBackup } from '../components/ConfigBackup'

export default function Skills(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <PageShell
      title={t('skills.title')}
      subtitle={t('skills.subtitle')}
      onBack={() => navigate('/')}
    >
      <div className="flex flex-col gap-9">
        <DiscoveredSkills />
        <BuiltInTools />
      </div>
    </PageShell>
  )
}

/** The real tools Roxy's agent can call, grouped by category (see `@shared/tools`). */
function BuiltInTools(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-7">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          {t('skills.builtInTools')}
        </h2>
        <p className="mt-1 text-xs text-text-muted">
          <Trans
            i18nKey="skills.builtInToolsBody"
            values={{ count: TOOLS.length }}
            components={[<Badge key="w">{t('skills.writes')}</Badge>]}
          />
        </p>
      </div>
      {TOOL_CATEGORIES.map((category) => (
        <section key={category}>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
            {category}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TOOLS.filter((t) => t.category === category).map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** Editor draft for creating or editing a skill. */
interface SkillDraft {
  mode: 'create' | 'edit'
  name: string
  description: string
  body: string
}

/** The real, filesystem-discovered skills (SKILL.md files under the user's global roots). */
function DiscoveredSkills(): JSX.Element {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillView[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    api.skills
      .list()
      .then(setSkills)
      .finally(() => setLoading(false))
  }, [])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setSkills(await api.skills.refresh())
    } finally {
      setRefreshing(false)
    }
  }

  const startEdit = async (name: string): Promise<void> => {
    const detail = await api.skills.read(name)
    setDraft({
      mode: 'edit',
      name,
      description: detail?.description ?? '',
      body: detail?.body ?? ''
    })
  }

  const remove = async (name: string): Promise<void> => {
    setSkills(await api.skills.remove(name))
    if (draft?.name === name) setDraft(null)
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          {t('skills.discovered')}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setInstalling((v) => !v)
              setDraft(null)
            }}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            {t('skills.addFromUrl')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft({ mode: 'create', name: '', description: '', body: '' })
              setInstalling(false)
            }}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('skills.newSkill')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {t('skills.rescan')}
          </Button>
          <ConfigBackup onImported={() => void refresh()} />
        </div>
      </div>

      <p className="mb-3 text-xs text-text-muted">
        <Trans
          i18nKey="skills.discoveredBody"
          components={{ code: <code className="text-text-subtle" /> }}
        />
      </p>

      {installing && (
        <InstallFromUrl
          onCancel={() => setInstalling(false)}
          onInstalled={(list) => {
            setSkills(list)
            setInstalling(false)
          }}
        />
      )}

      {draft && (
        <SkillEditor
          draft={draft}
          existing={skills}
          onCancel={() => setDraft(null)}
          onSaved={(list) => {
            setSkills(list)
            setDraft(null)
          }}
        />
      )}

      {loading ? (
        <p className="text-xs text-text-muted">{t('skills.scanning')}</p>
      ) : skills.length === 0 ? (
        !draft && !installing && <EmptySkills />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {skills.map((skill) => (
            <DiscoveredSkillCard
              key={skill.location}
              skill={skill}
              onEdit={() => startEdit(skill.name)}
              onRemove={() => remove(skill.name)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * "Add from URL" — Roxy's in-app `npx skills add`. Paste a GitHub repo (owner/repo
 * or a URL) or a direct SKILL.md link; it fetches and installs every skill it finds
 * into the global skills root.
 */
function InstallFromUrl({
  onCancel,
  onInstalled
}: {
  onCancel: () => void
  onInstalled: (list: SkillView[]) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string[] | null>(null)

  const install = async (): Promise<void> => {
    const src = source.trim()
    if (!src) {
      setError(t('skills.installNeedSource'))
      return
    }
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await api.skills.install(src)
      if (!res.ok) {
        setError(res.error ?? t('skills.installNothing'))
        return
      }
      setDone(res.installed.map((s) => s.name))
      onInstalled(res.skills)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('skills.installFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
      <h3 className="mb-1 text-sm font-medium text-text">{t('skills.installTitle')}</h3>
      <p className="mb-3 text-xs text-text-muted">
        <Trans
          i18nKey="skills.installBody"
          components={{ code: <code className="text-text-subtle" /> }}
        />
      </p>
      <div className="space-y-3">
        <Input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void install()
          }}
          placeholder={t('skills.installPlaceholder')}
          autoFocus
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        {done && (
          <p className="text-xs text-success">
            {t('skills.installedCount', { count: done.length, names: done.join(', ') })}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            {done ? t('common.close') : t('common.cancel')}
          </Button>
          <Button size="sm" onClick={install} disabled={busy} className="gap-1.5">
            {busy ? (
              t('skills.installing')
            ) : (
              <>
                <Download className="h-3.5 w-3.5" />
                {t('skills.install')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Create / edit form for a global skill. */
function SkillEditor({
  draft,
  existing,
  onCancel,
  onSaved
}: {
  draft: SkillDraft
  existing: SkillView[]
  onCancel: () => void
  onSaved: (list: SkillView[]) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description)
  const [body, setBody] = useState(draft.body)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isEdit = draft.mode === 'edit'

  const save = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError(t('skills.errNoName'))
      return
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmedName)) {
      setError(t('skills.errBadName'))
      return
    }
    if (!isEdit && existing.some((s) => s.name.toLowerCase() === trimmedName.toLowerCase())) {
      setError(t('skills.errDuplicate'))
      return
    }
    if (!body.trim()) {
      setError(t('skills.errNoBody'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const input = { name: trimmedName, description: description.trim() || undefined, body }
      const list = isEdit ? await api.skills.update(input) : await api.skills.create(input)
      onSaved(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('skills.errSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-4 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
      <h3 className="mb-3 text-sm font-medium text-text">
        {isEdit ? t('skills.editTitle', { name: draft.name }) : t('skills.newSkill')}
      </h3>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">{t('skills.fieldName')}</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit}
            placeholder={t('skills.fieldNamePlaceholder')}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">
            {t('skills.fieldDescription')}
          </label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('skills.fieldDescriptionPlaceholder')}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">{t('skills.fieldBody')}</label>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            placeholder={t('skills.fieldBodyPlaceholder')}
            className="font-mono text-xs"
          />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving
              ? t('skills.saving')
              : isEdit
                ? t('skills.saveChanges')
                : t('skills.createSkill')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function DiscoveredSkillCard({
  skill,
  onEdit,
  onRemove
}: {
  skill: SkillView
  onEdit: () => void
  onRemove: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="group flex items-start gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center sq sq-lg rounded-lg bg-white/5 text-text-muted">
        <FileText className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text">{skill.name}</span>
          <Badge>
            <span className="inline-flex items-center gap-1">
              {skill.source === 'workspace' ? (
                <FolderGit2 className="h-3 w-3" />
              ) : (
                <Home className="h-3 w-3" />
              )}
              {skill.source}
            </span>
          </Badge>
        </div>
        {skill.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">{skill.description}</p>
        )}
        <p className="mt-1 truncate text-[11px] text-text-subtle" title={skill.location}>
          {skill.location}
        </p>
        {confirming && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-danger">{t('skills.confirmDelete')}</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="danger" onClick={onRemove}>
              {t('common.delete')}
            </Button>
          </div>
        )}
      </div>
      {!confirming && (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={onEdit}
            title={t('common.edit')}
            className="press-scale flex h-7 w-7 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setConfirming(true)}
            title={t('common.delete')}
            className="press-scale flex h-7 w-7 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

function EmptySkills(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="sq sq-xl sq-ring sq-dashed rounded-xl border border-dashed border-border bg-surface/50 p-5 text-xs text-text-muted">
      <p className="text-text">{t('skills.emptyTitle')}</p>
      <p className="mt-2">
        <Trans i18nKey="skills.emptyBody" components={{ code: <code className="text-text" /> }} />
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <Trans
            i18nKey="skills.emptyGlobal"
            components={{ code: <code className="text-text" /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="skills.emptyProject"
            components={{ code: <code className="text-text" /> }}
          />
        </li>
      </ul>
      <p className="mt-2">
        <Trans i18nKey="skills.emptyFooter" components={{ code: <code className="text-text" /> }} />
      </p>
    </div>
  )
}

function ToolCard({ tool }: { tool: ToolDef }): JSX.Element {
  return (
    <div className="flex items-start gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center sq sq-lg rounded-lg bg-white/5 text-text-muted">
        <Wrench className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="text-sm font-medium text-text">{tool.name}</code>
          {tool.mutates && <Badge>writes</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-text-muted">{tool.description}</p>
      </div>
    </div>
  )
}
