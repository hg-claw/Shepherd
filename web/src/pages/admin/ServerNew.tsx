import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useInstall, useScriptInstall } from '@/api/servers'
import { useUI } from '@/store/ui'

const schema = z.object({
  name: z.string().min(1),
  ssh_host: z.string().min(1),
  ssh_port: z.coerce.number<number>().int().min(1).max(65535),
  ssh_user: z.string().min(1),
  ssh_password: z.string().optional(),
  ssh_key: z.string().optional(),
  arch: z.enum(['amd64', 'arm64']),
  public_alias: z.string().optional(),
  public_group: z.string().optional(),
  country_code: z.string().regex(/^[A-Z]{2}$/).optional().or(z.literal('')),
  show_on_public: z.boolean(),
}).refine((v) => !!v.ssh_password || !!v.ssh_key, {
  message: 'one of ssh_password or ssh_key required',
  path: ['ssh_password'],
})

type FormVals = z.infer<typeof schema>

function SshInstallForm() {
  const { t } = useTranslation()
  const install = useInstall()
  const toast = useUI((s) => s.toast)
  const navigate = useNavigate()
  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useForm<FormVals>({
    resolver: zodResolver(schema),
    defaultValues: { ssh_port: 22, arch: 'amd64', show_on_public: false, country_code: '' },
  })

  const arch = watch('arch')
  const show = watch('show_on_public')

  const onSubmit = async (vals: FormVals) => {
    try {
      const out = await install.mutateAsync({
        ...vals,
        country_code: vals.country_code || undefined,
        ssh_password: vals.ssh_password || undefined,
        ssh_key: vals.ssh_key || undefined,
      })
      navigate(`/admin/servers/${out.server_id}`)
    } catch (err: any) {
      toast('error', err?.message ?? t('common.error'))
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>SSH</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Field id="name" label={t('admin.name')} {...register('name')} error={errors.name?.message} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field id="ssh_host" label="ssh_host" {...register('ssh_host')} error={errors.ssh_host?.message} className="sm:col-span-2" />
            <Field id="ssh_port" label="port" type="number" {...register('ssh_port')} error={errors.ssh_port?.message} />
          </div>
          <Field id="ssh_user" label="ssh_user" {...register('ssh_user')} error={errors.ssh_user?.message} />
          <Field id="ssh_password" label="ssh_password" type="password" {...register('ssh_password')} error={errors.ssh_password?.message} />
          <div className="space-y-1">
            <Label htmlFor="ssh_key">ssh_key (PEM)</Label>
            <textarea
              id="ssh_key"
              rows={5}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              {...register('ssh_key')}
            />
            <p className="text-xs text-muted-foreground">
              Provide either password or key.
            </p>
          </div>
          <div className="space-y-1">
            <Label>Arch</Label>
            <Select value={arch} onValueChange={(v) => setValue('arch', v as 'amd64' | 'arm64')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="amd64">amd64</SelectItem>
                <SelectItem value="arm64">arm64</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field id="public_alias" label="public_alias" {...register('public_alias')} />
            <Field id="public_group" label="public_group" {...register('public_group')} />
            <Field id="country_code" label="country_code (XX)" {...register('country_code')} error={errors.country_code?.message} />
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={show} onCheckedChange={(v) => setValue('show_on_public', v)} id="show_on_public" />
            <Label htmlFor="show_on_public">show_on_public</Label>
          </div>
          <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">{t('admin.add_server')}</Button>
        </form>
      </CardContent>
    </Card>
  )
}

function ScriptInstallForm() {
  const scriptInstall = useScriptInstall()
  const toast = useUI((s) => s.toast)
  const [name, setName] = useState('')
  const [publicAlias, setPublicAlias] = useState('')
  const [publicGroup, setPublicGroup] = useState('')
  const [countryCode, setCountryCode] = useState('')
  const [showOnPublic, setShowOnPublic] = useState(false)
  const [result, setResult] = useState<{ command: string; expires_at: string } | null>(null)

  const submit = async () => {
    if (!name.trim()) { toast('error', 'name required'); return }
    try {
      const r = await scriptInstall.mutateAsync({
        name,
        public_alias: publicAlias || undefined,
        public_group: publicGroup || undefined,
        country_code: countryCode || undefined,
        show_on_public: showOnPublic,
      })
      setResult({ command: r.command, expires_at: r.expires_at })
    } catch (e: unknown) {
      toast('error', (e as Error).message)
    }
  }

  const copy = async () => {
    if (!result) return
    await navigator.clipboard.writeText(result.command)
    toast('success', 'copied')
  }

  if (result) {
    return (
      <Card>
        <CardHeader><CardTitle>Run this on the target host</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{result.command}</pre>
          <div className="flex items-center gap-2">
            <Button onClick={copy}>Copy</Button>
            <span className="text-xs text-muted-foreground">
              Token expires {new Date(result.expires_at).toLocaleString()}
            </span>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader><CardTitle>Add via install script</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Public alias</Label>
          <Input value={publicAlias} onChange={(e) => setPublicAlias(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Public group</Label>
          <Input value={publicGroup} onChange={(e) => setPublicGroup(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Country code (ISO-2)</Label>
          <Input value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} maxLength={2} />
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={showOnPublic} onCheckedChange={setShowOnPublic} />
          <Label>Show on public wall</Label>
        </div>
        <Button onClick={submit} disabled={scriptInstall.isPending}>
          {scriptInstall.isPending ? 'Issuing…' : 'Generate install command'}
        </Button>
      </CardContent>
    </Card>
  )
}

export default function ServerNew() {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">{t('admin.add_server')}</h1>
      <Tabs defaultValue="ssh" className="space-y-4">
        <TabsList>
          <TabsTrigger value="ssh">SSH install</TabsTrigger>
          <TabsTrigger value="script">Script install</TabsTrigger>
        </TabsList>
        <TabsContent value="ssh"><SshInstallForm /></TabsContent>
        <TabsContent value="script"><ScriptInstallForm /></TabsContent>
      </Tabs>
    </div>
  )
}

function Field({
  id,
  label,
  error,
  className,
  ...rest
}: {
  id: string
  label: string
  error?: string
  className?: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...rest} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
