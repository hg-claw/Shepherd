import { useLayoutEffect, useRef, useState, useMemo } from 'react'

type Series = { name: string; values: { ts: string; v: number }[]; color?: string }

type Props = {
  height?: number
  series: Series[]
  yMin?: number
  yMax?: number
  yFormat?: (v: number) => string
  tooltipFormat?: (v: number) => string
}

const DEFAULT_PALETTE = ['hsl(var(--primary))', 'hsl(var(--level-mid))', 'hsl(var(--level-alert))', 'hsl(var(--level-low))']

export function TimeSeriesChart({
  height = 120,
  series,
  yMin,
  yMax,
  yFormat = (v) => v.toFixed(0),
  tooltipFormat = (v) => v.toFixed(2),
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hoverX, setHoverX] = useState<number | null>(null)

  // Measure container width before paint and whenever it resizes.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const w = el.getBoundingClientRect().width
      setWidth(Math.max(120, Math.round(w)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const allValues = series.flatMap((s) => s.values.map((p) => p.v))
  const min = yMin ?? (allValues.length ? Math.min(...allValues) : 0)
  const max = yMax ?? (allValues.length ? Math.max(...allValues) : 1)
  const span = max - min || 1
  const allTs = series.flatMap((s) => s.values.map((p) => +new Date(p.ts)))
  const tMin = allTs.length ? Math.min(...allTs) : 0
  const tMax = allTs.length ? Math.max(...allTs) : 1
  const tSpan = tMax - tMin || 1

  const pad = { l: 40, r: 8, t: 8, b: 20 }
  const innerW = Math.max(0, width - pad.l - pad.r)
  const innerH = height - pad.t - pad.b

  const x = (ts: string) => pad.l + ((+new Date(ts) - tMin) / tSpan) * innerW
  const y = (v: number) => pad.t + (1 - (v - min) / span) * innerH

  const yTicks = useMemo(() => {
    const n = 4
    return [...Array(n + 1)].map((_, i) => min + (span * i) / n)
  }, [min, span])

  const xTicks = useMemo(() => {
    const n = 4
    return [...Array(n + 1)].map((_, i) => tMin + (tSpan * i) / n)
  }, [tMin, tSpan])

  const closestPoints = useMemo(() => {
    if (hoverX == null) return null
    return series.map((s) => {
      let best: { ts: string; v: number } | null = null
      let bestDx = Infinity
      for (const p of s.values) {
        const px = x(p.ts)
        const dx = Math.abs(px - hoverX)
        if (dx < bestDx) {
          bestDx = dx
          best = p
        }
      }
      return { name: s.name, point: best }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverX, series])

  return (
    <div ref={containerRef} className="relative w-full" style={{ overflow: 'hidden' }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          style={{ display: 'block' }}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
            setHoverX(e.clientX - rect.left)
          }}
          onMouseLeave={() => setHoverX(null)}
        >
          {yTicks.map((v, i) => (
            <g key={`y${i}`}>
              <line
                x1={pad.l}
                x2={width - pad.r}
                y1={y(v)}
                y2={y(v)}
                stroke="hsl(var(--border))"
                strokeDasharray="2 2"
              />
              <text x={4} y={y(v) + 4} fontSize={9} fill="hsl(var(--muted-foreground))">
                {yFormat(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={`x${i}`}
              x={pad.l + (innerW * i) / xTicks.length}
              y={height - 4}
              fontSize={9}
              fill="hsl(var(--muted-foreground))"
            >
              {new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </text>
          ))}
          {series.map((s, idx) => {
            if (s.values.length < 2) return null
            const d = s.values
              .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.ts).toFixed(1)} ${y(p.v).toFixed(1)}`)
              .join(' ')
            return (
              <path
                key={s.name}
                d={d}
                fill="none"
                stroke={s.color ?? DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length]}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )
          })}
          {hoverX != null && (
            <line
              x1={hoverX}
              x2={hoverX}
              y1={pad.t}
              y2={height - pad.b}
              stroke="hsl(var(--muted-foreground))"
            />
          )}
        </svg>
      )}
      {closestPoints && hoverX != null && (
        <div className="absolute right-2 top-2 rounded border bg-popover p-2 text-xs shadow">
          {closestPoints.map(
            (cp) =>
              cp.point && (
                <div key={cp.name}>
                  <span className="text-muted-foreground">{cp.name}:</span>{' '}
                  {tooltipFormat(cp.point.v)}
                </div>
              ),
          )}
        </div>
      )}
    </div>
  )
}
