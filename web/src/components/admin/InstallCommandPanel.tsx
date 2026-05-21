import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useUI } from '@/store/ui'

interface Props {
  command: string
  expiresAt: string
  title?: string
}

// Re-used from ServerNew (Script install) and ServerDetail (Re-issue
// command for an existing server). Centralizes the copy fallback so the
// clipboard logic isn't duplicated — navigator.clipboard.writeText only
// works in Secure Contexts (HTTPS/localhost); on plain HTTP we fall back
// to the textarea + document.execCommand('copy') pattern.
export function InstallCommandPanel({ command, expiresAt, title = 'Run this on the target host' }: Props) {
  const toast = useUI((s) => s.toast)

  const copy = async () => {
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command)
      } else {
        const ta = document.createElement('textarea')
        ta.value = command
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (!ok) throw new Error('execCommand copy returned false')
      }
      toast('success', 'copied')
    } catch (e) {
      toast('error', `copy failed: ${(e as Error).message ?? e}`)
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{command}</pre>
        <div className="flex items-center gap-2">
          <Button onClick={copy}>Copy</Button>
          <span className="text-xs text-muted-foreground">
            Token expires {new Date(expiresAt).toLocaleString()}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
