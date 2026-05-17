import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function OnlineDot({ online }: { online: boolean }) {
  const { t } = useTranslation()
  const label = online ? t('wall.online') : t('wall.offline')
  return (
    <span
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full',
        online ? 'bg-ok shadow-[0_0_0_3px_hsl(var(--ok-soft))] motion-safe:shep-pulse' : 'bg-err shadow-[0_0_0_3px_hsl(var(--err-soft))]',
      )}
      title={label}
      aria-label={label}
    />
  )
}
