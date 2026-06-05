const enc = (...n: number[]) => new Uint8Array(n)

export const KEYS: Record<string, Uint8Array> = {
  esc: enc(0x1b),
  tab: enc(0x09),
  ctrlC: enc(0x03),
  ctrlD: enc(0x04),
  ctrlZ: enc(0x1a),
  up: enc(0x1b, 0x5b, 0x41),
  down: enc(0x1b, 0x5b, 0x42),
  right: enc(0x1b, 0x5b, 0x43),
  left: enc(0x1b, 0x5b, 0x44),
  enter: enc(0x0d),
  backspace: enc(0x7f),
}

export function charBytes(s: string): Uint8Array {
  // Inline UTF-8 encoder (avoids TextEncoder dependency and deprecated unescape).
  const bytes: number[] = []
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i) ?? 0
    if (cp <= 0x7f) {
      bytes.push(cp)
    } else if (cp <= 0x7ff) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp <= 0xffff) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
      i++ // surrogate pair — advance extra
    }
    i++
  }
  return new Uint8Array(bytes)
}
