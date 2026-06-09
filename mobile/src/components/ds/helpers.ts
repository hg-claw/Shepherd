// Status helpers ported verbatim from docs/mobile-redesign/ui.jsx.

export type PillKind = 'ok' | 'warn' | 'err' | 'neutral'

export function statusOf(s: { online: boolean; cpu: number; mem: number; disk: number }): {
  kind: PillKind; label: string
} {
  if (!s.online) return { kind: 'neutral', label: 'offline' }
  const top = Math.max(s.cpu, s.mem, s.disk)
  if (top >= 92) return { kind: 'err', label: 'critical' }
  if (top >= 80) return { kind: 'warn', label: 'warn' }
  return { kind: 'ok', label: 'healthy' }
}

// '' | 'warn' | 'err' — the metric-bar tint threshold.
export function barKind(v: number | null | undefined): '' | 'warn' | 'err' {
  return v == null ? '' : v >= 92 ? 'err' : v >= 80 ? 'warn' : ''
}
