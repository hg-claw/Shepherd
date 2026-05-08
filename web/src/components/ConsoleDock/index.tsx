import { useConsoleTabs } from '@/store/consoleTabs'
import { XtermPane } from './XtermPane'

export function ConsoleDock() {
  const { tabs, active, focus, close } = useConsoleTabs()
  if (tabs.length === 0) return null
  return (
    <div className="fixed bottom-0 left-0 right-0 h-80 border-t bg-black text-white flex flex-col z-50">
      <div className="flex gap-1 bg-zinc-900 px-2 py-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => focus(t.id)}
            className={`px-2 py-0.5 text-xs ${t.id === active ? 'bg-zinc-700' : 'bg-zinc-800'} ${t.status === 'exited' ? 'opacity-60' : ''}`}
          >
            {t.title}
            {t.status === 'exited' ? ` (exit ${t.exitCode})` : ''}
            <span
              className="ml-2 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                close(t.id)
              }}
            >
              ×
            </span>
          </button>
        ))}
      </div>
      <div className="flex-1 relative">
        {tabs.map((t) => (
          <div key={t.id} className={`absolute inset-0 ${t.id === active ? '' : 'hidden'}`}>
            <XtermPane tabId={t.id} sid={t.sid} />
          </div>
        ))}
      </div>
    </div>
  )
}
