/**
 * Convert ISO 3166-1 alpha-2 code to a flag emoji using regional indicator chars.
 * Returns empty string for invalid input.
 */
export function flagEmoji(code: string | null | undefined): string {
  if (!code || code.length !== 2) return ''
  const upper = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return ''
  const A = 0x41
  const RI = 0x1f1e6
  const c1 = RI + (upper.charCodeAt(0) - A)
  const c2 = RI + (upper.charCodeAt(1) - A)
  return String.fromCodePoint(c1, c2)
}
