import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ErrorState({ message, onRetry, className }: {
  message?: string
  onRetry?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      <div className="text-sm text-err">{message ?? t('common.error')}</div>
      {onRetry && (
        <Button variant="outline" className="h-7" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}
