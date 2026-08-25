import {
  Brain,
  Code,
  Cpu,
  Database,
  FilePen,
  FileText,
  FlaskConical,
  Folder,
  GitBranch,
  Globe,
  Hash,
  History,
  Inbox,
  LayoutGrid,
  Library,
  Mail,
  MessageCircle,
  MessagesSquare,
  Mic,
  Monitor,
  MonitorSmartphone,
  MousePointer,
  Plug,
  Search,
  Send,
  Shield,
  Smartphone,
  Terminal,
  Timer,
  type LucideIcon
} from 'lucide-react'

/** Maps catalog icon names (from src/shared) to lucide components. */
const ICONS: Record<string, LucideIcon> = {
  send: Send,
  'message-circle': MessageCircle,
  hash: Hash,
  'messages-square': MessagesSquare,
  shield: Shield,
  smartphone: Smartphone,
  globe: Globe,
  'git-branch': GitBranch,
  mail: Mail,
  inbox: Inbox,
  folder: Folder,
  terminal: Terminal,
  search: Search,
  code: Code,
  // Marketplace: add-on kinds, capabilities and catalog entries.
  brain: Brain,
  cpu: Cpu,
  database: Database,
  'file-pen': FilePen,
  'file-text': FileText,
  'flask-conical': FlaskConical,
  history: History,
  'layout-grid': LayoutGrid,
  library: Library,
  mic: Mic,
  monitor: Monitor,
  'monitor-smartphone': MonitorSmartphone,
  'mouse-pointer': MousePointer,
  plug: Plug,
  timer: Timer
}

export function CatalogIcon({
  name,
  className
}: {
  name: string
  className?: string
}): JSX.Element {
  const Cmp = ICONS[name] ?? Code
  return <Cmp className={className} />
}
