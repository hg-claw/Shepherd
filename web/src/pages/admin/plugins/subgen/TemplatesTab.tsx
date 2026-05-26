import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Copy as CopyIcon, Trash2 } from 'lucide-react'
import {
  listSubgenTemplates,
  listSubgenCategories,
  createSubgenTemplate,
  updateSubgenTemplate,
  deleteSubgenTemplate,
  type SubgenTemplate,
  type SubgenCategory,
} from '@/api/subgen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useUI } from '@/store/ui'

const POLICIES = ['PROXY', 'DIRECT', 'REJECT'] as const
type Policy = (typeof POLICIES)[number] | string

// Working model parsed out of / serialized back into rules_json.
interface CategoryRule { name: string; policy: Policy }
interface CustomRule { match: string; policy: Policy }
interface RulesModel {
  categories: CategoryRule[]
  custom_rules: CustomRule[]
  final: string
  group_by_country: boolean
  include_auto_select: boolean
}

function parseRules(rules_json: string): RulesModel {
  let raw: any = {}
  try { raw = JSON.parse(rules_json || '{}') } catch { raw = {} }
  return {
    categories: Array.isArray(raw.categories)
      ? raw.categories.map((c: any) => ({ name: String(c.name ?? ''), policy: String(c.policy ?? 'PROXY') }))
      : [],
    custom_rules: Array.isArray(raw.custom_rules)
      ? raw.custom_rules.map((c: any) => ({ match: String(c.match ?? ''), policy: String(c.policy ?? 'PROXY') }))
      : [],
    final: String(raw.final ?? 'PROXY'),
    group_by_country: Boolean(raw.group_by_country),
    include_auto_select: Boolean(raw.include_auto_select),
  }
}

function customRulesToText(rules: CustomRule[]): string {
  // Each line: TYPE,VALUE,policy  (match already holds "TYPE,VALUE")
  return rules.map((r) => `${r.match},${r.policy}`).join('\n')
}

function textToCustomRules(text: string): CustomRule[] {
  const out: CustomRule[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(',')
    if (parts.length < 3) continue
    const policy = parts[parts.length - 1].trim()
    const match = parts.slice(0, parts.length - 1).map((p) => p.trim()).join(',')
    out.push({ match, policy })
  }
  return out
}

export default function TemplatesTab() {
  const toast = useUI((s) => s.toast)
  const qc = useQueryClient()

  const tplQ = useQuery({ queryKey: ['subgen-templates'], queryFn: listSubgenTemplates })
  const catQ = useQuery({ queryKey: ['subgen-categories'], queryFn: listSubgenCategories })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['subgen-templates'] })

  const remove = useMutation({
    mutationFn: deleteSubgenTemplate,
    onSuccess: invalidate,
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  // editor state: either editing an existing custom template (id set) or
  // creating a new one (id null). `seed` provides the prefill rules.
  const [editing, setEditing] = useState<{ id: number | null; name: string; rules: string } | null>(null)

  const templates = tplQ.data ?? []
  const categories = catQ.data ?? []

  const openNew = () => setEditing({ id: null, name: '', rules: '{}' })
  const openEdit = (t: SubgenTemplate) => setEditing({ id: t.id, name: t.name, rules: t.rules_json })
  const openClone = (t: SubgenTemplate) =>
    setEditing({ id: null, name: `${t.name} copy`, rules: t.rules_json })

  if (tplQ.isError) {
    return <div className="text-err text-[13px]">Failed to load templates: {(tplQ.error as Error).message}</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          Templates describe how nodes map to policies and which rule-sets to include. Built-in templates are read-only — clone one to customize.
        </p>
        <Button size="sm" className="h-8" onClick={openNew}>
          <Plus className="h-3.5 w-3.5 mr-1" /> New template
        </Button>
      </div>

      <div className="rounded-lg border bg-elev overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Name</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Type</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="px-3 py-2 font-mono">{t.name}</td>
                <td className="px-3 py-2">
                  {t.builtin
                    ? <Badge variant="secondary">built-in</Badge>
                    : <Badge variant="outline">custom</Badge>}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {t.builtin ? (
                    <Button variant="outline" size="sm" className="h-7 px-2 text-[12px]"
                      onClick={() => openClone(t)}>
                      <CopyIcon className="h-3.5 w-3.5 mr-1" /> Clone
                    </Button>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" className="h-7 px-2 text-[12px] mr-1"
                        onClick={() => openEdit(t)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                        disabled={remove.isPending}
                        onClick={() => { if (confirm(`Delete template "${t.name}"?`)) remove.mutate(t.id) }}
                        aria-label="delete">
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {templates.length === 0 && (
              <tr><td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">No templates.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <TemplateEditor
          key={editing.id ?? 'new'}
          editing={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => { invalidate(); setEditing(null) }}
        />
      )}
    </div>
  )
}

// ── Template editor ──────────────────────────────────────────────────────────

function TemplateEditor({
  editing, categories, onClose, onSaved,
}: {
  editing: { id: number | null; name: string; rules: string }
  categories: SubgenCategory[]
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useUI((s) => s.toast)

  const initial = parseRules(editing.rules)
  const [name, setName] = useState(editing.name)
  // map category name → policy; absence = unchecked
  const [catPolicies, setCatPolicies] = useState<Record<string, Policy>>(
    () => Object.fromEntries(initial.categories.map((c) => [c.name, c.policy])),
  )
  const [customText, setCustomText] = useState(customRulesToText(initial.custom_rules))
  const [final, setFinal] = useState<string>(initial.final)
  const [groupByCountry, setGroupByCountry] = useState(initial.group_by_country)
  const [includeAutoSelect, setIncludeAutoSelect] = useState(initial.include_auto_select)

  const toggleCat = (name: string, defaultPolicy: string) => {
    setCatPolicies((prev) => {
      const next = { ...prev }
      if (name in next) delete next[name]
      else next[name] = defaultPolicy || 'PROXY'
      return next
    })
  }
  const setCatPolicy = (name: string, policy: Policy) =>
    setCatPolicies((prev) => ({ ...prev, [name]: policy }))

  const serialize = (): string => {
    const model: RulesModel = {
      categories: Object.entries(catPolicies).map(([name, policy]) => ({ name, policy })),
      custom_rules: textToCustomRules(customText),
      final,
      group_by_country: groupByCountry,
      include_auto_select: includeAutoSelect,
    }
    return JSON.stringify(model)
  }

  const save = useMutation({
    mutationFn: () => {
      const rules = serialize()
      return editing.id == null
        ? createSubgenTemplate(name.trim(), rules)
        : updateSubgenTemplate(editing.id, name.trim(), rules)
    },
    onSuccess: () => { toast('success', 'Template saved'); onSaved() },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing.id == null ? 'New template' : 'Edit template'}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto space-y-4">
          <div>
            <Label className="text-[12px]">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 mt-1" />
          </div>

          <div>
            <Label className="text-[12px]">Categories</Label>
            <p className="text-fg-dim text-[11px] mt-0.5 mb-2">
              Check a category to route its rule-sets; pick a policy. Rule URLs are the GitHub subscription addresses shipped with each category.
            </p>
            <div className="space-y-2">
              {categories.map((c) => {
                const checked = c.name in catPolicies
                return (
                  <div key={c.name} className="rounded-md border bg-sunken/30 p-2">
                    <div className="flex items-center gap-2 text-[12.5px]">
                      <input type="checkbox" checked={checked}
                        onChange={() => toggleCat(c.name, c.default_policy)} aria-label={`category ${c.name}`} />
                      <span className="font-mono">{c.name}</span>
                      {checked && (
                        <select value={catPolicies[c.name]} onChange={(e) => setCatPolicy(c.name, e.target.value)}
                          className="h-6 px-1.5 ml-auto rounded border bg-background text-[11.5px]">
                          {POLICIES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      )}
                      {!checked && (
                        <span className="ml-auto text-fg-dim text-[11px]">default {c.default_policy}</span>
                      )}
                    </div>
                    {c.rule_urls.length > 0 && (
                      <ul className="mt-1 pl-6 space-y-0.5">
                        {c.rule_urls.map((u) => (
                          <li key={u} className="font-mono text-[10.5px] text-fg-dim break-all">{u}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
              {categories.length === 0 && (
                <div className="text-fg-dim text-[12px]">No categories defined.</div>
              )}
            </div>
          </div>

          <div>
            <Label className="text-[12px]">Custom rules</Label>
            <p className="text-fg-dim text-[11px] mt-0.5 mb-1">
              One <code>TYPE,VALUE,policy</code> per line (e.g. <code>DOMAIN-SUFFIX,example.com,DIRECT</code>).
            </p>
            <textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              rows={5}
              className="w-full px-2 py-1.5 rounded-md border bg-background text-[12px] font-mono"
              placeholder="DOMAIN-SUFFIX,example.com,DIRECT"
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={groupByCountry}
                onChange={(e) => setGroupByCountry(e.target.checked)} />
              Group by country
            </label>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={includeAutoSelect}
                onChange={(e) => setIncludeAutoSelect(e.target.checked)} />
              Include auto-select group
            </label>
            <div className="flex items-center gap-2 text-[12.5px]">
              <span>Final</span>
              <select value={final} onChange={(e) => setFinal(e.target.value)}
                className="h-7 px-1.5 rounded border bg-background text-[11.5px]">
                {POLICIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
