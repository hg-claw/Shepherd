import { useEffect, useRef } from 'react'

export function InstallProgress({ log, stage }: { log: string; stage: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [log])
  return (
    <div className="space-y-2">
      <div className="text-sm">stage: {stage}</div>
      <pre
        ref={ref}
        className="max-h-72 overflow-auto rounded border bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
      >
        {log || '...'}
      </pre>
    </div>
  )
}
