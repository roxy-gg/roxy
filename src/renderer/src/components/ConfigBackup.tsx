import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Upload } from 'lucide-react'
import type { ConfigImportResult } from '@shared/api'
import { api } from '../lib/api'
import { Button } from './ui'

/**
 * Export/Import buttons for the portable config bundle (global skills + MCP
 * server configs). Reused in Settings (both features) and — scoped down via the
 * `only` prop for labels — could sit on the Skills / MCP pages. Everything is a
 * no-op on cancel; a short status line reports the outcome.
 *
 * `onImported` lets the host refresh whatever it shows (skills list, MCP list)
 * after a successful import.
 */
export function ConfigBackup({
  onImported,
  className
}: {
  onImported?: (result: ConfigImportResult) => void
  className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const doExport = async (): Promise<void> => {
    setBusy('export')
    setStatus(null)
    try {
      const res = await api.config.export()
      if (res.error) {
        setStatus({ tone: 'err', text: t('configBackup.exportFailedWith', { error: res.error }) })
      } else if (!res.ok) {
        // Cancelled the save dialog — say nothing loud.
        setStatus(null)
      } else {
        setStatus({ tone: 'ok', text: t('configBackup.exported', { summary: res.summary }) })
      }
    } catch (e) {
      setStatus({
        tone: 'err',
        text: e instanceof Error ? e.message : t('configBackup.exportFailed')
      })
    } finally {
      setBusy(null)
    }
  }

  const doImport = async (): Promise<void> => {
    setBusy('import')
    setStatus(null)
    try {
      const res = await api.config.import()
      if (res.cancelled) {
        setStatus(null)
      } else if (!res.ok) {
        setStatus({ tone: 'err', text: res.error ?? t('configBackup.nothingImported') })
      } else {
        const skipNote = res.skipped.length
          ? ` ${t('configBackup.skippedNote', { count: res.skipped.length })}`
          : ''
        setStatus({ tone: 'ok', text: `${res.summary}${skipNote}` })
        onImported?.(res)
      }
    } catch (e) {
      setStatus({
        tone: 'err',
        text: e instanceof Error ? e.message : t('configBackup.importFailed')
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          className="shrink-0"
          disabled={busy !== null}
          onClick={() => void doExport()}
        >
          <Download className="h-3.5 w-3.5" />{' '}
          {busy === 'export' ? t('configBackup.exporting') : t('configBackup.export')}
        </Button>
        <Button
          variant="secondary"
          className="shrink-0"
          disabled={busy !== null}
          onClick={() => void doImport()}
        >
          <Upload className="h-3.5 w-3.5" />{' '}
          {busy === 'import' ? t('configBackup.importing') : t('configBackup.import')}
        </Button>
        {status && (
          <span className={`text-xs ${status.tone === 'ok' ? 'text-success' : 'text-danger'}`}>
            {status.text}
          </span>
        )}
      </div>
    </div>
  )
}
