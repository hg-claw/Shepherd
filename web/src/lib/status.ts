// Single source of truth for status colours. Pill consumes statusStyles;
// MetricBadge's level scale (low/mid/high/alert) lives in thresholds.ts
// and is re-exported here so both mappings share one import site.
export { levelClass, type Level } from '@/lib/thresholds'

export type StatusKind = 'ok' | 'warn' | 'err' | 'neutral'

export const statusStyles: Record<
  StatusKind,
  { bg: string; text: string; dot: string; pulse: string }
> = {
  ok: { bg: 'bg-ok-soft', text: 'text-ok', dot: 'bg-ok', pulse: 'shep-pulse' },
  warn: { bg: 'bg-warn-soft', text: 'text-warn', dot: 'bg-warn', pulse: 'shep-pulse-warn' },
  err: { bg: 'bg-err-soft', text: 'text-err', dot: 'bg-err', pulse: 'shep-pulse-err' },
  neutral: { bg: 'bg-sunken', text: 'text-muted-foreground', dot: 'bg-muted-foreground', pulse: '' },
}
