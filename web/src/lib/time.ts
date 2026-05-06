export type RelativeKey =
  | 'common.just_now'
  | 'common.second_ago'
  | 'common.minute_ago'
  | 'common.hour_ago'
  | 'common.day_ago'

/**
 * relativeTime returns the i18next key + the `n` value for templating.
 * Caller does t(key, { n }).
 */
export function relativeTime(when: Date | string | null | undefined, now: Date = new Date()): { key: RelativeKey; n: number } | null {
  if (when == null) return null
  const t = typeof when === 'string' ? new Date(when) : when
  if (isNaN(t.getTime())) return null
  const seconds = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 1000))
  if (seconds < 5) return { key: 'common.just_now', n: 0 }
  if (seconds < 60) return { key: 'common.second_ago', n: seconds }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { key: 'common.minute_ago', n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { key: 'common.hour_ago', n: hours }
  const days = Math.floor(hours / 24)
  return { key: 'common.day_ago', n: days }
}

export function formatHHMM(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
