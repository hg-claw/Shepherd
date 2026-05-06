import { useEffect } from 'react'
import { useToast } from '@/hooks/use-toast'
import { useUI } from '@/store/ui'

export function ToastBridge() {
  const { toasts, dismissToast } = useUI()
  const { toast: shadcnToast } = useToast()

  useEffect(() => {
    for (const t of toasts) {
      shadcnToast({
        title: t.kind === 'error' ? 'Error' : t.kind === 'success' ? 'Success' : 'Info',
        description: t.message,
        variant: t.kind === 'error' ? 'destructive' : 'default',
      })
      dismissToast(t.id)
    }
  }, [toasts, shadcnToast, dismissToast])

  return null
}
