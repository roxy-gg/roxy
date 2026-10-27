import {
  Activity,
  Bell,
  DatabaseBackup,
  GitBranch,
  Globe,
  Image,
  Info,
  Languages,
  Lightbulb,
  Mic,
  MousePointer2,
  Palette,
  PanelLeft,
  ScanEye,
  ScanLine,
  Plug,
  Sparkles,
  UserRound,
  MonitorSmartphone,
  Shield
} from 'lucide-react'

export const SETTINGS_GROUPS = [
  {
    label: 'settings.navigation.theme',
    items: [
      { id: 'background', label: 'appearance.background', icon: Image },
      { id: 'sidebar', label: 'settings.navigation.sidebar', icon: PanelLeft },
      { id: 'colors', label: 'settings.navigation.colors', icon: Palette },
      { id: 'motion', label: 'settings.motion.label', icon: Sparkles }
    ]
  },
  {
    label: 'settings.navigation.addOns',
    items: [
      { id: 'skills', label: 'sidebar.skills', icon: Lightbulb },
      { id: 'mcp', label: 'sidebar.mcpServers', icon: Plug },
      { id: 'engineering', label: 'engineering.heading', icon: ScanEye },
      { id: 'cheat', label: 'cheat.title', icon: ScanLine },
      { id: 'backup', label: 'settings.backup.heading', icon: DatabaseBackup }
    ]
  },
  {
    label: 'settings.navigation.general',
    items: [
      { id: 'accounts', label: 'settings.navigation.accounts', icon: UserRound },
      { id: 'browser', label: 'settings.browser.heading', icon: Globe },
      { id: 'language', label: 'settings.language.heading', icon: Languages },
      { id: 'voice', label: 'voice.heading', icon: Mic },
      { id: 'narrete', label: 'narrete.heading', icon: MousePointer2 },
      { id: 'worktrees', label: 'settings.navigation.worktrees', icon: GitBranch },
      { id: 'notifications', label: 'settings.notifications.heading', icon: Bell },
      { id: 'remote', label: 'sidebar.remoteWorkspace', icon: MonitorSmartphone },
      { id: 'activity', label: 'settings.navigation.activity', icon: Activity },
      { id: 'privacy', label: 'settings.privacy.heading', icon: Shield },
      { id: 'about', label: 'settings.about.heading', icon: Info }
    ]
  }
] as const

export type SettingsSection = (typeof SETTINGS_GROUPS)[number]['items'][number]['id']
