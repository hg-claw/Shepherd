import React, { useId, useState } from 'react'
import { View, Text, type LayoutChangeEvent } from 'react-native'
import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg'
import { useTheme } from '@/theme'

export type ChartPoint = { x: number; y: number | null }
export type ChartDatum = number | null | undefined | ChartPoint

// normalizeSeries flattens the accepted input shapes (numbers or {x,y}) into a
// y-value series, mapping non-finite values to null (rendered as gaps).
export function normalizeSeries(data: readonly ChartDatum[]): (number | null)[] {
  return data.map((d) => {
    const v = typeof d === 'object' && d != null ? d.y : d
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  })
}

export type ChartGeometry = { line: string; area: string; min: number; max: number; last: number }

// chartGeometry builds the SVG line + area paths for a series scaled to w×h.
// Nulls split the series into segments (gaps). Returns null when there is
// nothing to draw (empty or all-null data).
export function chartGeometry(ys: readonly (number | null)[], w: number, h: number, pad = 3): ChartGeometry | null {
  const finite = ys.filter((v): v is number => v != null)
  if (finite.length === 0 || w <= 0 || h <= 0) return null
  let min = finite[0]; let max = finite[0]; let last = finite[0]
  for (const v of finite) {
    if (v < min) min = v
    if (v > max) max = v
    last = v
  }
  const span = max - min
  const n = ys.length
  const xAt = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w)
  const yAt = (v: number) => (span === 0 ? h / 2 : pad + (1 - (v - min) / span) * (h - 2 * pad))

  const lines: string[] = []
  const areas: string[] = []
  let seg: { x: number; y: number }[] = []
  const flush = () => {
    if (seg.length === 0) return
    const d = seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
    lines.push(d)
    areas.push(`${d} L${seg[seg.length - 1].x.toFixed(1)} ${h} L${seg[0].x.toFixed(1)} ${h} Z`)
    seg = []
  }
  ys.forEach((v, i) => {
    if (v == null) { flush(); return }
    seg.push({ x: xAt(i), y: yAt(v) })
  })
  flush()
  return { line: lines.join(' '), area: areas.join(' '), min, max, last }
}

// .chart: thin area/line sparkline. min/max labels mono 9 muted, right-aligned
// over the plot. Empty / all-null data → centered dim "no data".
export function AreaChart({ data, height = 56, color, fill = true, format, testID }: {
  data: readonly ChartDatum[]
  height?: number
  color?: string
  fill?: boolean
  format?: (v: number) => string
  testID?: string
}) {
  const t = useTheme()
  const gid = `ac-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [w, setW] = useState(0)
  const ys = normalizeSeries(data)
  const hasData = ys.some((v) => v != null)
  const stroke = color ?? t.primary
  const g = hasData && w > 0 ? chartGeometry(ys, w, height) : null
  const fmt = format ?? ((v: number) => String(Math.round(v)))
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)

  if (!hasData) {
    return (
      <View testID={testID} onLayout={onLayout} style={{ height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>no data</Text>
      </View>
    )
  }
  return (
    <View testID={testID} onLayout={onLayout} style={{ height }}>
      {g ? (
        <>
          <Svg width={w} height={height}>
            {fill ? (
              <Defs>
                <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={stroke} stopOpacity={0.22} />
                  <Stop offset="1" stopColor={stroke} stopOpacity={0.02} />
                </LinearGradient>
              </Defs>
            ) : null}
            {fill ? <Path d={g.area} fill={`url(#${gid})`} /> : null}
            <Path d={g.line} stroke={stroke} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          </Svg>
          {g.max !== g.min ? (
            <Text style={{ position: 'absolute', top: 1, right: 4, fontFamily: t.mono(), fontSize: 9, color: t.muted }}>
              {fmt(g.max)}
            </Text>
          ) : null}
          <Text style={{ position: 'absolute', bottom: 1, right: 4, fontFamily: t.mono(), fontSize: 9, color: t.muted }}>
            {fmt(g.min)}
          </Text>
        </>
      ) : null}
    </View>
  )
}
