import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { useScript, useCreateScript, useUpdateScript, type Param } from '@/api/scripts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

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
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">
          {mode === 'create' ? t('scripts.new', 'New script') : t('scripts.edit', 'Edit script')}
        </h1>
      </div>

      {/* Basic fields */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-[12.5px]">
            {t('scripts.details', 'Details')}
          </span>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <Label className="text-[12px]">{t('scripts.name', 'Name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 font-mono text-[12.5px]"
              placeholder="my-script"
            />
          </div>
          <div>
            <Label className="text-[12px]">{t('scripts.description', 'Description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 text-[12.5px]"
              placeholder="One-line description"
            />
          </div>
          <div>
            <Label className="text-[12px]">
              {t('scripts.default_timeout', 'Default timeout (s)')}
            </Label>
            <Input
              type="number"
              value={defaultTimeout}
              onChange={(e) => setDefaultTimeout(e.target.value)}
              className="mt-1 w-32 font-mono text-[12.5px]"
              placeholder="300"
            />
          </div>
        </div>
      </div>

      {/* Script content */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-[12.5px]">
            {t('scripts.content', 'Script content')}
          </span>
        </div>
        <div className="p-4">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full font-mono text-[12px] rounded-md border border-input bg-[#09090b] text-zinc-200 p-3 min-h-[200px] ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y leading-relaxed"
            placeholder="#!/usr/bin/env bash&#10;set -euo pipefail&#10;"
          />
          <p className="text-fg-dim font-mono text-[11px] mt-1.5">
            hint · bash/sh shebang line is required · env vars injected as UPPERCASE param names
          </p>
        </div>
      </div>

      {/* Parameters */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-[12.5px]">
            {t('scripts.params', 'Params')}
          </span>
          <span className="text-fg-dim font-mono text-[11px]">{params.length} defined</span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 px-2 text-[12px] gap-1"
            onClick={() => setParams([...params, { name: '', required: false, default: '' }])}
          >
            <Plus className="h-3 w-3" />
            {t('scripts.add_param', 'Add')}
          </Button>
        </div>

        {params.length === 0 ? (
          <div className="px-4 py-6 text-center text-fg-dim font-mono text-[12px]">
            no parameters defined
          </div>
        ) : (
          <div className="divide-y">
            {params.map((p, i) => (
              <div
                key={i}
                className="flex items-start gap-2 px-4 py-3 flex-wrap sm:flex-nowrap"
              >
                <div className="min-w-0 flex-1">
                  <Label className="text-[10.5px] uppercase tracking-wide text-muted-foreground">name</Label>
                  <Input
                    value={p.name}
                    onChange={(e) => {
                      const next = [...params]
                      next[i] = { ...next[i], name: e.target.value }
                      setParams(next)
                    }}
                    className="mt-1 h-7 font-mono text-[12px]"
                    placeholder="param_name"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <Label className="text-[10.5px] uppercase tracking-wide text-muted-foreground">label</Label>
                  <Input
                    value={p.label ?? ''}
                    onChange={(e) => {
                      const next = [...params]
                      next[i] = { ...next[i], label: e.target.value }
                      setParams(next)
                    }}
                    className="mt-1 h-7 text-[12px]"
                    placeholder="Human-readable label"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <Label className="text-[10.5px] uppercase tracking-wide text-muted-foreground">default</Label>
                  <Input
                    value={p.default ?? ''}
                    onChange={(e) => {
                      const next = [...params]
                      next[i] = { ...next[i], default: e.target.value }
                      setParams(next)
                    }}
                    className="mt-1 h-7 font-mono text-[12px]"
                    placeholder="default value"
                  />
                </div>
                <div className="flex items-center gap-2 mt-auto pb-[1px]">
                  <label className={cn('flex items-center gap-1.5 text-[12px] cursor-pointer whitespace-nowrap mt-5')}>
                    <input
                      type="checkbox"
                      checked={!!p.required}
                      onChange={(e) => {
                        const next = [...params]
                        next[i] = { ...next[i], required: e.target.checked }
                        setParams(next)
                      }}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    <span className="text-[12px]">required</span>
                  </label>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 mt-5 shrink-0"
                    onClick={() => setParams(params.filter((_, j) => j !== i))}
                    aria-label="remove param"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 pt-1">
        <Button onClick={submit} disabled={create.isPending || update.isPending} className="gap-1.5">
          {t('common.save', 'Save')}
        </Button>
      </div>
    </div>
  )
}
