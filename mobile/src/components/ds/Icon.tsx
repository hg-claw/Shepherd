import React from 'react'
import {
  ChevronLeft, ChevronRight, ChevronDown, Server, Puzzle, Settings, Sun, Moon, Plus,
  ArrowDown, ArrowUp, SquareTerminal, FolderTree, Play, Folder, File, CornerLeftUp,
  ScrollText, Target, RotateCw, RefreshCw, ScanFace, Lock, User, Globe, LogOut,
  Activity, Cloud, Gauge, Archive, Shield, Network, X, CircleQuestionMark,
  Rss, Box, Package, Terminal,
} from 'lucide-react-native'

type IconComp = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>

// lucide@1.x renamed CircleHelp -> CircleQuestionMark; we alias it for the fallback/help slot.
const MAP: Record<string, IconComp> = {
  'chevron-left': ChevronLeft, 'chevron-right': ChevronRight, 'chevron-down': ChevronDown,
  server: Server, puzzle: Puzzle, settings: Settings, sun: Sun, moon: Moon, plus: Plus,
  'arrow-down': ArrowDown, 'arrow-up': ArrowUp, 'square-terminal': SquareTerminal,
  'folder-tree': FolderTree, play: Play, folder: Folder, file: File,
  'corner-left-up': CornerLeftUp, 'scroll-text': ScrollText, target: Target,
  'rotate-cw': RotateCw, 'refresh-cw': RefreshCw, 'scan-face': ScanFace, lock: Lock,
  user: User, globe: Globe, 'log-out': LogOut, activity: Activity, cloud: Cloud,
  gauge: Gauge, archive: Archive, shield: Shield, network: Network, x: X,
  rss: Rss, box: Box, package: Package, terminal: Terminal,
  'circle-help': CircleQuestionMark,
}

export function Icon({ name, size = 18, color, strokeWidth = 1.6 }: {
  name: string; size?: number; color?: string; strokeWidth?: number
}) {
  const C = MAP[name] ?? CircleQuestionMark
  return <C size={size} color={color} strokeWidth={strokeWidth} />
}
