import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function LoadingState({ label, className }: { label?: string; className?: string }) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground', className)}>
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  )
}
