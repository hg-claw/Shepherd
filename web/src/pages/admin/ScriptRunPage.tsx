import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { useScript, useRunScript } from '@/api/scripts'
import { useServers } from '@/api/servers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OnlineDot } from '@/components/OnlineDot'
import { cn } from '@/lib/utils'

export default function ScriptRunPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const numId = id ? Number(id) : undefined
  const { data: script } = useScript(numId)
  const { data: servers } = useServers()
  const run = useRunScript()
  const navigate = useNavigate()
  const [args, setArgs] = useState<Record<string, string>>({})
  const [targets, setTargets] = useState<number[]>([])

  if (!script) return <div className="text-muted-foreground text-[13px] p-4">{t('common.loading')}</div>

  const submit = async () => {
    const out = await run.mutateAsync({ id: script.id, args, target_server_ids: targets })
    navigate(`/admin/script-runs/${out.run_id}`)
  }

  const onlineServers = (servers ?? []).filter((s) => {
    const ls = s.agent_last_seen
    if (!ls || !ls.Valid) return false
    return Date.now() - new Date(ls.Time).getTime() <= 90_000
  })
  const allServers = servers ?? []

  const pickAll = () => setTargets(onlineServers.map((s) => s.id))
  const pickNone = () => setTargets([])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight m-0 break-all">
          {t('scripts.run', 'Run')}: <span className="font-mono">{script.name}</span>
        </h1>
        <p className="text-muted-foreground text-[13px] mt-1">{script.description}</p>
      </div>

      {/* Parameters */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-[12.5px]">
            {t('scripts.params', 'Parameters')}
          </span>
        </div>
        <div className="p-4">
          {(script.params ?? []).length === 0 ? (
            <p className="text-fg-dim font-mono text-[12px]">
              {t('scripts.no_params', 'no parameters defined')}
            </p>
          ) : (
            <div className="space-y-3">
              {(script.params ?? []).map((p) => (
                <div key={p.name} className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-2 items-start">
                  <div>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-[12.5px] font-medium">{p.name}</span>
                      {p.required && <span className="text-err text-[12px]">*</span>}
                    </div>
                    {p.label && (
                      <div className="text-fg-dim text-[11px] mt-0.5">{p.label}</div>
                    )}
                  </div>
                  <Input
                    value={args[p.name] ?? p.default ?? ''}
                    onChange={(e) => setArgs({ ...args, [p.name]: e.target.value })}
                    placeholder={p.default ?? ''}
                    className="h-7 font-mono text-[12.5px]"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Target picker */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b flex-wrap">
          <span className="text-foreground font-medium text-[12.5px]">
            {t('scripts.targets', 'Target servers')}
          </span>
          <span className="text-fg-dim font-mono text-[11px]">
            {targets.length}/{allServers.length} selected
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[12px]" onClick={pickAll}>
              Select online
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[12px]" onClick={pickNone}>
              Clear
            </Button>
          </div>
        </div>
        <div className="p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
            {allServers.map((s) => {
              const ls = s.agent_last_seen
              const online = ls?.Valid
                ? Date.now() - new Date(ls.Time).getTime() <= 90_000
                : false
              const checked = targets.includes(s.id)
              return (
                <label
                  key={s.id}
                  className={cn(
                    'flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-[12.5px] font-mono cursor-pointer transition-colors',
                    checked
                      ? 'bg-accent/20 border-accent/50 text-accent-foreground'
                      : 'bg-sunken border-border hover:border-muted-foreground/50',
                    !online && 'opacity-50',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      setTargets((prev) =>
                        e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                      )
                    }
                    disabled={!online}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <OnlineDot online={online} />
                  <span className="truncate flex-1">{s.name}</span>
                </label>
              )
            })}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 pt-1">
        <span className="font-mono text-[12.5px] text-fg-dim">
          {script.default_timeout_s ? `timeout · ${script.default_timeout_s}s per target` : ''}
        </span>
        <Button
          onClick={submit}
          disabled={targets.length === 0 || run.isPending}
          className="ml-auto sm:ml-0 gap-1.5"
        >
          <Play className="h-3.5 w-3.5" />
          {t('scripts.run_button', 'Run on {{n}} servers', { n: targets.length })}
        </Button>
      </div>
    </div>
  )
}
