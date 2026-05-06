import { useTranslation } from 'react-i18next'
import { levelClass, levelForNetBps, levelForPct, type Level, type Metric } from '@/lib/thresholds'
import { bps } from '@/lib/bytes'
import { cn } from '@/lib/utils'

export type DisplayMode = 'raw' | 'level' | 'both'

type CommonProps = {
  metric: Metric
  mode: DisplayMode
  className?: string
}

type PctProps = CommonProps & { kind: 'pct'; value: number | null | undefined }
type NetProps = CommonProps & { kind: 'net'; rxBps: number; txBps: number }

export function MetricBadge(props: PctProps | NetProps) {
  const { t } = useTranslation()
  const { mode, metric, className } = props

  let level: Level
  let raw: string
  if (props.kind === 'net') {
    level = levelForNetBps(props.rxBps, props.txBps)
    raw = `↓ ${bps(props.rxBps)}  ↑ ${bps(props.txBps)}`
  } else {
    level = levelForPct(metric as 'cpu' | 'mem' | 'disk', props.value ?? null)
    raw = props.value == null ? '-' : `${props.value.toFixed(0)}%`
  }
  const levelLabel = t(`level.${level}`)

  if (mode === 'raw') {
    return <span className={cn('font-mono', className)}>{raw}</span>
  }
  if (mode === 'level') {
    return (
      <span className={cn('inline-flex rounded px-2 py-0.5 text-xs', levelClass[level], className)}>
        {levelLabel}
      </span>
    )
  }
  return (
    <span className={cn('inline-flex items-center gap-2 font-mono', className)}>
      <span>{raw}</span>
      <span className={cn('rounded px-2 py-0.5 text-xs', levelClass[level])}>{levelLabel}</span>
    </span>
  )
}
