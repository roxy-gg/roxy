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
  Shield,
  Blocks
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
      { id: 'addons', label: 'settings.navigation.addons', icon: Blocks },
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

/** Add-ons listed in the Add-Ons hub. Each card opens its own settings section. */
export const ADDON_CARDS = [
  {
    id: 'engineering',
    label: 'engineering.heading',
    icon: ScanEye,
    description: 'settings.addons.engineeringDescription'
  },
  {
    id: 'cheat',
    label: 'cheat.title',
    icon: ScanLine,
    description: 'settings.addons.cheatDescription'
  }
] as const

/** Every navigable section: sidebar entries plus the add-on sections behind the hub. */
export const SETTINGS_SECTIONS = [
  ...SETTINGS_GROUPS.flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.label }))
  ),
  ...ADDON_CARDS.map((card) => ({
    id: card.id,
    label: card.label,
    icon: card.icon,
    group: 'settings.navigation.addOns' as const
  }))
]

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']
