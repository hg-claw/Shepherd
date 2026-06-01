import { useEffect } from 'react'
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast'
import { useUI, type Toast as UIToast } from '@/store/ui'

const AUTO_DISMISS_MS = 5000

function ToastItem({ t, onDismiss }: { t: UIToast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const h = setTimeout(() => onDismiss(t.id), AUTO_DISMISS_MS)
    return () => clearTimeout(h)
  }, [t.id, onDismiss])
  return (
    <Toast variant={t.kind === 'error' ? 'destructive' : 'default'} onOpenChange={(open) => { if (!open) onDismiss(t.id) }}>
      <div className="grid gap-1">
        <ToastTitle>{t.kind === 'error' ? 'Error' : t.kind === 'success' ? 'Success' : 'Info'}</ToastTitle>
        <ToastDescription>{t.message}</ToastDescription>
      </div>
      <ToastClose />
    </Toast>
  )
}

// Toaster renders the zustand useUI.toasts directly — one source of truth, no
// limit-1 drop. Each item auto-dismisses after AUTO_DISMISS_MS.
export function Toaster() {
  const toasts = useUI((s) => s.toasts)
  const dismissToast = useUI((s) => s.dismissToast)
  return (
    <ToastProvider>
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} onDismiss={dismissToast} />
      ))}
      <ToastViewport />
    </ToastProvider>
  )
}
