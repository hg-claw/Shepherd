import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { useScript, useCreateScript, useUpdateScript, type Param } from '@/api/scripts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface Props {
  mode: 'create' | 'edit'
}

export default function ScriptEditPage({ mode }: Props) {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const numId = id ? Number(id) : undefined
  const { data: existing } = useScript(mode === 'edit' ? numId : undefined)
  const create = useCreateScript()
  const update = useUpdateScript()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [params, setParams] = useState<Param[]>([])
  const [defaultTimeout, setDefaultTimeout] = useState<string>('')

  useEffect(() => {
    if (existing) {
      setName(existing.name)
      setDescription(existing.description)
      setContent(existing.content)
      setParams(existing.params ?? [])
      setDefaultTimeout(existing.default_timeout_s ? String(existing.default_timeout_s) : '')
    }
  }, [existing])

  const submit = async () => {
    const payload = {
      name,
      description,
      content,
      params,
      default_timeout_s: defaultTimeout ? Number(defaultTimeout) : null,
    }
    if (mode === 'create') {
      const created = await create.mutateAsync(payload)
      navigate(`/admin/scripts/${created.id}`)
    } else {
      await update.mutateAsync({ ...payload, id: numId! })
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">
        {mode === 'create' ? t('scripts.new', 'New script') : t('scripts.edit', 'Edit script')}
      </h1>
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div>
            <Label>{t('scripts.name', 'Name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>{t('scripts.description', 'Description')}</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <Label>{t('scripts.content', 'Content')}</Label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full font-mono text-sm border rounded p-2 min-h-32"
            />
          </div>
          <div>
            <Label>{t('scripts.default_timeout', 'Default timeout (s)')}</Label>
            <Input
              type="number"
              value={defaultTimeout}
              onChange={(e) => setDefaultTimeout(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>{t('scripts.params', 'Params')}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setParams([...params, { name: '', required: false, default: '' }])
              }
            >
              <Plus className="h-4 w-4 mr-1" />
              {t('scripts.add_param', 'Add')}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {params.map((p, i) => (
            <div key={i} className="flex gap-2 items-end">
              <div className="flex-1">
                <Label className="text-xs">name</Label>
                <Input
                  value={p.name}
                  onChange={(e) => {
                    const next = [...params]
                    next[i] = { ...next[i], name: e.target.value }
                    setParams(next)
                  }}
                />
              </div>
              <div className="flex-1">
                <Label className="text-xs">label</Label>
                <Input
                  value={p.label ?? ''}
                  onChange={(e) => {
                    const next = [...params]
                    next[i] = { ...next[i], label: e.target.value }
                    setParams(next)
                  }}
                />
              </div>
              <div className="flex-1">
                <Label className="text-xs">default</Label>
                <Input
                  value={p.default ?? ''}
                  onChange={(e) => {
                    const next = [...params]
                    next[i] = { ...next[i], default: e.target.value }
                    setParams(next)
                  }}
                />
              </div>
              <div>
                <Label className="text-xs">required</Label>
                <input
                  type="checkbox"
                  checked={!!p.required}
                  onChange={(e) => {
                    const next = [...params]
                    next[i] = { ...next[i], required: e.target.checked }
                    setParams(next)
                  }}
                  className="block mt-2"
                />
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setParams(params.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      <Button onClick={submit} disabled={create.isPending || update.isPending}>
        {t('common.save', 'Save')}
      </Button>
    </div>
  )
}
