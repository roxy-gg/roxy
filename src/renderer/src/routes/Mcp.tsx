import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { McpServers } from '../components/McpServers'
import { McpTrustPanel } from '../components/McpTrustPanel'
import { PageShell } from '../components/PageShell'

export default function Mcp(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <PageShell
      title={t('mcpPage.title')}
      subtitle={t('mcpPage.subtitle')}
      onBack={() => navigate('/')}
    >
      <McpServers showBackup />
      {/* Consent lives next to the servers it governs, not buried in Settings:
          the question "what have I allowed to run?" is asked here. */}
      <section className="mt-8 border-t border-border pt-6">
        <h2 className="mb-1 text-sm font-medium text-text">{t('mcpTrust.panelTitle')}</h2>
        <McpTrustPanel />
      </section>
    </PageShell>
  )
}
