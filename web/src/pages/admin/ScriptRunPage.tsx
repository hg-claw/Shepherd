import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useScript, useRunScript } from '@/api/scripts'
import { useServers } from '@/api/servers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'

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

  if (!script) return <div>{t('common.loading')}</div>

  const submit = async () => {
    const out = await run.mutateAsync({ id: script.id, args, target_server_ids: targets })
    navigate(`/admin/script-runs/${out.run_id}`)
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">
        {t('scripts.run', 'Run')}: {script.name}
      </h1>
      <Card>
        <CardContent className="pt-4 space-y-2">
          {(script.params ?? []).map((p) => (
            <div key={p.name}>
              <Label>
                {p.label || p.name}
                {p.required ? ' *' : ''}
              </Label>
              <Input
                value={args[p.name] ?? p.default ?? ''}
                onChange={(e) => setArgs({ ...args, [p.name]: e.target.value })}
              />
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <Label>{t('scripts.targets', 'Target servers')}</Label>
          <div className="grid grid-cols-2 gap-1 mt-2">
            {(servers ?? []).map((s) => (
              <label key={s.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={targets.includes(s.id)}
                  onChange={(e) =>
                    setTargets((prev) =>
                      e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                    )
                  }
                />
                <span className="text-sm">{s.name}</span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>
      <Button onClick={submit} disabled={targets.length === 0 || run.isPending}>
        {t('scripts.run_button', 'Run on {{n}} servers', { n: targets.length })}
      </Button>
    </div>
  )
}
