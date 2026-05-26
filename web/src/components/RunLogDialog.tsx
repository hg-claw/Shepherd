import { useTranslation } from 'react-i18next'
import { useTargetLog } from '@/api/scripts'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'

/**
 * RunLogDialog — a button that opens the full plain-text execution log for
 * one script-run target. The log is the terminal output the PTY service
 * recorded (asciicast), flattened to text by the server. Polls every 2s
 * while the target is still running so a live run streams in.
 */
export function RunLogDialog({
  ptySessionId,
  running = false,
  triggerLabel,
  triggerClassName = 'text-[12px] text-muted-foreground hover:underline',
  title,
}: {
  ptySessionId: number | null | undefined
  running?: boolean
  triggerLabel?: string
  triggerClassName?: string
  title?: string
}) {
  const { t } = useTranslation()
  if (!ptySessionId) return null
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={triggerClassName} onClick={(e) => e.stopPropagation()}>
          {triggerLabel ?? t('scripts.view_log', 'View log')}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{title ?? t('scripts.execution_log', 'Execution log')}</DialogTitle>
        </DialogHeader>
        <LogBody ptySessionId={ptySessionId} running={running} />
      </DialogContent>
    </Dialog>
  )
}

function LogBody({ ptySessionId, running }: { ptySessionId: number; running: boolean }) {
  const { t } = useTranslation()
  const { data, isLoading, error } = useTargetLog(ptySessionId, running ? 2000 : undefined)
  if (isLoading) {
    return <div className="text-fg-dim text-[12px] py-2">{t('common.loading', 'Loading…')}</div>
  }
  if (error) {
    return <div className="text-err text-[12px] py-2">{t('scripts.no_log', 'No log recorded for this run.')}</div>
  }
  const text = data ?? ''
  if (text.trim() === '') {
    return <div className="text-fg-dim text-[12px] py-2">{t('scripts.empty_log', 'No output was captured.')}</div>
  }
  return (
    <pre className="max-h-[60vh] overflow-auto rounded-md border bg-sunken px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words">
      {text}
    </pre>
  )
}
