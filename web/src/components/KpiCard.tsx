type Tone = 'ok' | 'warn' | 'err'

type Props = {
  label: string
  value: string | number
  sub?: string
  tone?: Tone
}

/**
 * KpiCard — big number with an eyebrow label and optional semantic tone.
 * Maps to the design's <Kpi> primitive.
 * Tone drives the value color: ok → text-ok, warn → text-warn, err → text-err.
 */
export function KpiCard({ label, value, sub, tone }: Props) {
  const valueClass =
    tone === 'ok'
      ? 'text-ok'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'err'
          ? 'text-err'
          : 'text-foreground'

  return (
    <div className="bg-elev border rounded-lg px-4 py-3.5">
      <div className="text-[11.5px] uppercase tracking-[0.05em] text-muted-foreground whitespace-nowrap">
        {label}
      </div>
      <div
        className={`font-mono text-[26px] mt-1.5 tabular-nums leading-none tracking-tight ${valueClass}`}
      >
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[11px] text-muted-foreground mt-1.5">{sub}</div>
      )}
    </div>
  )
}
