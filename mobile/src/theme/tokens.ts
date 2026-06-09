// Shepherd design tokens — HSL triplets lifted from docs/mobile-redesign/colors_and_type.css.
// RN accepts hsl()/hsla() color strings, so we keep the triplets verbatim and render them.

export type Mode = 'light' | 'dark'

// token name → "H S% L%"
const LIGHT = {
  background: '60 14% 98%',
  foreground: '240 6% 10%',
  card: '0 0% 100%',
  bgElev: '0 0% 100%',
  bgSunken: '60 9% 95%',
  primary: '217 89% 47%',
  primaryFg: '0 0% 100%',
  border: '45 13% 89%',
  borderStrong: '45 11% 82%',
  input: '45 13% 89%',
  muted: '0 0% 42%',
  fgDim: '45 4% 58%',
  ok: '145 53% 41%',
  okSoft: '145 50% 94%',
  warn: '38 87% 53%',
  warnSoft: '38 80% 94%',
  err: '0 78% 50%',
  errSoft: '0 75% 95%',
  destructive: '0 78% 50%',
  destructiveFg: '0 0% 100%',
} as const

const DARK: Record<keyof typeof LIGHT, string> = {
  background: '240 4% 5%',
  foreground: '60 3% 93%',
  card: '240 5% 8%',
  bgElev: '240 5% 8%',
  bgSunken: '240 6% 10%',
  primary: '213 92% 67%',
  primaryFg: '240 6% 5%',
  border: '240 6% 15%',
  borderStrong: '240 6% 19%',
  input: '240 6% 15%',
  muted: '0 0% 63%',
  fgDim: '0 0% 42%',
  ok: '145 50% 55%',
  okSoft: '145 30% 14%',
  warn: '38 85% 60%',
  warnSoft: '38 30% 14%',
  err: '0 75% 65%',
  errSoft: '0 30% 16%',
  destructive: '0 72% 60%',
  destructiveFg: '0 0% 100%',
}

export type TokenName = keyof typeof LIGHT
export const TOKENS: Record<Mode, Record<TokenName, string>> = { light: LIGHT, dark: DARK }

// Render a triplet ("H S% L%") as an RN-acceptable hsl()/hsla() color string.
export function hslOf(triplet: string, alpha?: number): string {
  const [h, s, l] = triplet.split(/\s+/)
  return alpha == null ? `hsl(${h}, ${s}, ${l})` : `hsla(${h}, ${s}, ${l}, ${alpha})`
}

// Geist family names registered by @expo-google-fonts in the root layout.
export const FONT = { 400: 'Geist_400Regular', 500: 'Geist_500Medium', 600: 'Geist_600SemiBold', 700: 'Geist_700Bold' } as const
export const MONO = { 400: 'GeistMono_400Regular', 500: 'GeistMono_500Medium', 600: 'GeistMono_600SemiBold' } as const

// Dense type scale (px) from the design.
export const FS = { micro: 10.5, tiny: 11.5, xs: 12, sm: 12.5, base: 13.5, md: 14, lg: 18, xl: 22, xxl: 26 } as const
export const RADIUS = { sm: 4, base: 6, lg: 10, pill: 9999 } as const
