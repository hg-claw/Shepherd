import { flagEmoji } from '@/lib/country'

export function CountryFlag({ code }: { code: string | null | undefined }) {
  const emoji = flagEmoji(code)
  if (!emoji) return null
  return <span aria-hidden>{emoji}</span>
}
