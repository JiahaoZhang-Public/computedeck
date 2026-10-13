import {
  ArrowLeftRight,
  BarChart3,
  BellRing,
  Bot,
  Cloud,
  KeyRound,
  Mail,
  MessagesSquare,
  Network,
  Puzzle,
  Server,
  Shield,
  Users,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** Icons a plugin may name in its manifest (`icon`); anything else is a puzzle piece. */
const ICONS: Record<string, LucideIcon> = {
  bell: BellRing,
  chat: MessagesSquare,
  transfer: ArrowLeftRight,
  network: Network,
  users: Users,
  key: KeyRound,
  mail: Mail,
  chart: BarChart3,
  shield: Shield,
  server: Server,
  cloud: Cloud,
  bot: Bot,
  wrench: Wrench,
  puzzle: Puzzle,
};

export function toolIcon(name: string | null | undefined): LucideIcon {
  return (name && ICONS[name]) || Puzzle;
}
