import { useTranslation } from 'react-i18next'
import { McpServers } from '../components/McpServers'

export default function Mcp({ active }: { active: boolean }): JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <p className="mb-6 text-sm text-text-muted">{t('mcpPage.subtitle')}</p>
      <McpServers showBackup active={active} />
    </>
  )
}
