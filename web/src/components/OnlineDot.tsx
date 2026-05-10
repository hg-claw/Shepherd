import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function OnlineDot({ online }: { online: boolean }) {
  const { t } = useTranslation()
  const label = online ? t('wall.online') : t('wall.offline')
  return (
    <span className="relative inline-flex h-2 w-2" title={label} aria-label={label}>
      {online && (
        <span
          className="absolute inset-0 inline-flex h-full w-full rounded-full bg-level-low/60 motion-safe:animate-ping"
          aria-hidden
        />
      )}
      <span
        className={cn(
          'relative inline-flex h-2 w-2 rounded-full',
          online ? 'bg-level-low shadow-[0_0_6px_hsl(var(--level-low)/0.7)]' : 'bg-level-alert',
        )}
      />
    </span>
  )
}
