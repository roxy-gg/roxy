import { useEffect, useRef, useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Download, Braces, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { SkillView } from '@shared/api'
import { api } from '../lib/api'
import { Button, Input, Textarea } from '../components/ui'
import { ConfigBackup } from '../components/ConfigBackup'
import { CatalogSearch } from '../components/CatalogSearch'

export default function Skills({ active }: { active: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillView[]>([])

  return (
    <div className="@container">
      <p className="mb-6 text-sm text-text-muted">{t('skills.subtitle')}</p>
      <div className="flex flex-col gap-9">
        <DiscoveredSkills active={active} skills={skills} setSkills={setSkills} />
      </div>
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
function DiscoveredSkills({
  active,
  skills,
  setSkills
}: {
  active: boolean
  skills: SkillView[]
  setSkills: (skills: SkillView[]) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [raw, setRaw] = useState<{ name: string; text: string; location: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const editRequest = useRef(0)

  useEffect(() => {
    if (!active) return
    let alive = true
    setError(null)
    api.skills
      .list()
      .then((rows) => {
        if (alive) setSkills(rows)
      })
      .catch(() => {
        if (alive) setError(t('catalog.listFailed'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [active, setSkills, t])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      setSkills(await api.skills.refresh())
    } catch {
      setError(t('catalog.listFailed'))
    } finally {
      setRefreshing(false)
    }
  }

  const startEdit = async (name: string): Promise<void> => {
    const version = ++editRequest.current
    setError(null)
    try {
      const detail = await api.skills.read(name)
      if (version !== editRequest.current) return
      if (!detail) throw Error()
      setRaw(null)
      setInstalling(false)
      setDraft({
        mode: 'edit',
        name,
        description: detail?.description ?? '',
        body: detail?.body ?? ''
      })
    } catch {
      if (version === editRequest.current) setError(t('catalog.actionFailed'))
    }
  }

  const startRaw = async (name: string): Promise<void> => {
    const version = ++editRequest.current
    setError(null)
    try {
      const file = await api.skills.readRaw(name)
      if (version !== editRequest.current) return
      setRaw({ name, ...file })
      setDraft(null)
      setInstalling(false)
    } catch {
      if (version === editRequest.current) setError(t('catalog.actionFailed'))
    }
  }

  useEffect(
    () => () => {
      editRequest.current++
    },
    [active]
  )

  const remove = async (name: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSkills(await api.skills.remove(name))
      if (draft?.name === name) setDraft(null)
      if (raw?.name === name) setRaw(null)
      setRemoving(null)
    } catch {
      setError(t('catalog.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              editRequest.current++
              setInstalling((v) => !v)
              setDraft(null)
              setRaw(null)
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
              editRequest.current++
              setDraft({ mode: 'create', name: '', description: '', body: '' })
              setInstalling(false)
              setRaw(null)
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
          key={`${draft.mode}:${draft.name}`}
          draft={draft}
          existing={skills}
          onCancel={() => setDraft(null)}
          onSaved={(list) => {
            setSkills(list)
            setDraft(null)
          }}
        />
      )}

      {raw && (
        <RawSkillEditor
          key={raw.location}
          file={raw}
          onCancel={() => setRaw(null)}
          onSaved={(list) => {
            setSkills(list)
            setRaw(null)
          }}
        />
      )}
      {removing && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3 text-xs"
        >
          <span>{t('skills.confirmDeleteNamed', { name: removing })}</span>
          <Button size="sm" disabled={busy} variant="ghost" onClick={() => setRemoving(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={busy} variant="danger" onClick={() => void remove(removing)}>
            {t('common.delete')}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="mb-3 text-xs text-danger">
          {error}
        </p>
      )}
      {loading && <p className="text-xs text-text-muted">{t('skills.scanning')}</p>}
      <CatalogSearch
        kind="skills"
        active={active}
        installedSkills={skills}
        onSkillsInstalled={setSkills}
        renderSkillActions={(skill) => (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void startEdit(skill.name)}
              title={t('common.edit')}
              aria-label={t('catalog.editNamed', { name: skill.name })}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void startRaw(skill.name)}
              title={t('skills.editRaw')}
              aria-label={t('skills.editRawNamed', { name: skill.name })}
            >
              <Braces className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setRemoving(skill.name)}
              title={t('common.delete')}
              aria-label={t('catalog.removeNamed', { name: skill.name })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      />
    </div>
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
    if (!isEdit && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmedName)) {
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

function RawSkillEditor({
  file,
  onCancel,
  onSaved
}: {
  file: { name: string; text: string; location: string }
  onCancel: () => void
  onSaved: (skills: SkillView[]) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(file.text)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (saving || text === file.text) return
    setSaving(true)
    setError(null)
    try {
      onSaved(
        await api.skills.saveRaw({
          name: file.name,
          text,
          expectedText: file.text,
          location: file.location
        })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('skills.errSaveFailed'))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="mb-4 space-y-3 rounded-lg border border-border bg-surface p-4">
      <h3 className="text-sm font-medium text-text">
        {t('skills.editRawNamed', { name: file.name })}
      </h3>
      <p className="text-xs text-text-subtle">{t('skills.rawHint')}</p>
      <Textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={18}
        className="font-mono text-xs"
        spellCheck={false}
        aria-label={t('skills.rawLabel', { name: file.name })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void save()
          }
        }}
      />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" disabled={saving || text === file.text} onClick={() => void save()}>
          {saving ? t('skills.saving') : t('skills.saveChanges')}
        </Button>
      </div>
    </div>
  )
}
