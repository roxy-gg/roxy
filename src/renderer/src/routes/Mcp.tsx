import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { McpServers } from '../components/McpServers'
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
    </PageShell>
  )
}
