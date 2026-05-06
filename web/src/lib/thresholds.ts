export type Level = 'low' | 'mid' | 'high' | 'alert'

export type Metric = 'cpu' | 'mem' | 'disk' | 'net'

const cpuMemDisk: Record<'cpu' | 'mem' | 'disk', [number, number, number]> = {
  cpu: [40, 70, 90],
  mem: [50, 75, 90],
  disk: [60, 80, 90],
}

const NET_LOW_MBPS = 10
const NET_MID_MBPS = 50
const NET_HIGH_MBPS = 200

export function levelForPct(metric: 'cpu' | 'mem' | 'disk', pct: number | null | undefined): Level {
  if (pct == null) return 'low'
  const [a, b, c] = cpuMemDisk[metric]
  if (pct < a) return 'low'
  if (pct < b) return 'mid'
  if (pct < c) return 'high'
  return 'alert'
}

export function levelForNetBps(rxBps: number, txBps: number): Level {
  const mbps = Math.max(rxBps, txBps) / (1024 * 1024)
  if (mbps < NET_LOW_MBPS) return 'low'
  if (mbps < NET_MID_MBPS) return 'mid'
  if (mbps < NET_HIGH_MBPS) return 'high'
  return 'alert'
}

export const levelClass: Record<Level, string> = {
  low: 'bg-level-low text-white',
  mid: 'bg-level-mid text-black',
  high: 'bg-level-high text-white',
  alert: 'bg-level-alert text-white',
}
