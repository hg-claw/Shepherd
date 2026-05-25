import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Seg } from '@/components/Seg'
import { useInstall, useScriptInstall } from '@/api/servers'
import { useUI } from '@/store/ui'
import { InstallCommandPanel } from '@/components/admin/InstallCommandPanel'
import { cn } from '@/lib/utils'

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

type TabKey = 'ssh' | 'script'

/** Inline tab bar — underline style matching the design. */
function TabBar({ active, onChange }: { active: TabKey; onChange: (v: TabKey) => void }) {
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'ssh', label: 'SSH install' },
    { key: 'script', label: 'Script install' },
  ]
  return (
    <div className="flex border-b">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={cn(
            'px-3 py-2 text-[13px] -mb-px border-b-2 transition-colors',
            active === tab.key
              ? 'border-foreground text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** Compact field wrapper: label + input + optional error or hint. */
function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id?: string
  label: string
  hint?: string
  error?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={id} className="text-[12.5px] font-medium">
        {label}
      </Label>
      {children}
      {hint && !error && (
        <span className="font-mono text-[11.5px] text-fg-dim">{hint}</span>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** Simple input field (wraps shadcn Input). */
function InputField({
  id,
  label,
  hint,
  error,
  className,
  ...rest
}: {
  id: string
  label: string
  hint?: string
  error?: string
  className?: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field id={id} label={label} hint={hint} error={error} className={className}>
      <Input id={id} className="h-8 text-[13px]" {...rest} />
    </Field>
  )
}

function SshInstallForm() {
  const { t } = useTranslation()
  const install = useInstall()
  const toast = useUI((s) => s.toast)
  const navigate = useNavigate()
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormVals>({
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
      <CardHeader className="pb-3">
        <CardTitle className="text-[14px]">SSH</CardTitle>
        <CardDescription className="text-[12.5px]">
          {t('servernew.ssh_desc', 'Credentials are used once and discarded after install.')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3.5">
          <InputField
            id="name"
            label={t('admin.name', 'Name')}
            error={errors.name?.message}
            {...register('name')}
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <InputField
              id="ssh_host"
              label="ssh_host"
              placeholder="10.0.5.42"
              error={errors.ssh_host?.message}
              className="sm:col-span-2"
              {...register('ssh_host')}
            />
            <InputField
              id="ssh_port"
              label="port"
              type="number"
              error={errors.ssh_port?.message}
              {...register('ssh_port')}
            />
          </div>
          <InputField
            id="ssh_user"
            label="ssh_user"
            error={errors.ssh_user?.message}
            {...register('ssh_user')}
          />
          <InputField
            id="ssh_password"
            label="ssh_password"
            type="password"
            error={errors.ssh_password?.message}
            {...register('ssh_password')}
          />
          <Field id="ssh_key" label="ssh_key (PEM)" hint="Provide either password or key.">
            <textarea
              id="ssh_key"
              rows={5}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-vertical"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              {...register('ssh_key')}
            />
          </Field>
          <Field label="Arch">
            <Seg
              value={arch}
              onChange={(v) => setValue('arch', v as 'amd64' | 'arm64')}
              size="sm"
              options={[
                { value: 'amd64' as const, label: 'amd64' },
                { value: 'arm64' as const, label: 'arm64' },
              ]}
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <InputField id="public_alias" label="public_alias" {...register('public_alias')} />
            <InputField id="public_group" label="public_group" {...register('public_group')} />
            <InputField
              id="country_code"
              label="country_code (XX)"
              maxLength={2}
              error={errors.country_code?.message}
              {...register('country_code')}
            />
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={show}
              onCheckedChange={(v) => setValue('show_on_public', v)}
              id="show_on_public"
            />
            <Label htmlFor="show_on_public" className="text-[12.5px]">
              {t('servernew.show_on_public', 'Show on public wall')}
            </Label>
          </div>
          <div className="flex justify-end pt-1">
            <Button type="submit" disabled={isSubmitting} size="sm">
              {t('admin.add_server', 'Add server')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ScriptInstallForm() {
  const { t } = useTranslation()
  const scriptInstall = useScriptInstall()
  const toast = useUI((s) => s.toast)
  const [name, setName] = useState('')
  const [publicAlias, setPublicAlias] = useState('')
  const [publicGroup, setPublicGroup] = useState('')
  const [countryCode, setCountryCode] = useState('')
  const [showOnPublic, setShowOnPublic] = useState(false)
  const [cnMirror, setCNMirror] = useState(false)
  const [result, setResult] = useState<{ command: string; expires_at: string } | null>(null)

  const submit = async () => {
    if (!name.trim()) {
      toast('error', t('servernew.name_required', 'name required'))
      return
    }
    try {
      const r = await scriptInstall.mutateAsync({
        name,
        public_alias: publicAlias || undefined,
        public_group: publicGroup || undefined,
        country_code: countryCode || undefined,
        show_on_public: showOnPublic,
        cn: cnMirror,
      })
      setResult({ command: r.command, expires_at: r.expires_at })
    } catch (e: unknown) {
      toast('error', (e as Error).message)
    }
  }

  if (result) {
    return <InstallCommandPanel command={result.command} expiresAt={result.expires_at} />
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-[14px]">
          {t('servernew.script_title', 'Add via install script')}
        </CardTitle>
        <CardDescription className="text-[12.5px]">
          {t('servernew.script_desc', 'Generate a one-time install command to run on the target host.')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3.5">
          <Field id="script-name" label={t('admin.name', 'Name')}>
            <Input
              id="script-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 text-[13px]"
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field id="script-alias" label={t('servernew.public_alias', 'Public alias')}>
              <Input
                id="script-alias"
                value={publicAlias}
                onChange={(e) => setPublicAlias(e.target.value)}
                className="h-8 text-[13px]"
              />
            </Field>
            <Field id="script-group" label={t('servernew.public_group', 'Public group')}>
              <Input
                id="script-group"
                value={publicGroup}
                onChange={(e) => setPublicGroup(e.target.value)}
                className="h-8 text-[13px]"
              />
            </Field>
            <Field id="script-cc" label={t('servernew.country_code', 'Country code (ISO-2)')}>
              <Input
                id="script-cc"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
                maxLength={2}
                className="h-8 text-[13px]"
              />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={showOnPublic}
              onCheckedChange={setShowOnPublic}
              id="script-public"
            />
            <Label htmlFor="script-public" className="text-[12.5px]">
              {t('servernew.show_on_public', 'Show on public wall')}
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={cnMirror}
              onCheckedChange={setCNMirror}
              id="script-cn"
            />
            <Label htmlFor="script-cn" className="text-[12.5px]">
              {t('servernew.cn_mirror', 'CN mirror (gh-proxy.com — for mainland-China hosts)')}
            </Label>
          </div>
          <div className="flex justify-end pt-1">
            <Button
              onClick={submit}
              disabled={scriptInstall.isPending}
              size="sm"
            >
              {scriptInstall.isPending
                ? t('servernew.issuing', 'Issuing…')
                : t('servernew.generate', 'Generate install command')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function ServerNew() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabKey>('script')

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight m-0">
            {t('admin.add_server', 'Add server')}
          </h1>
          <p className="text-muted-foreground text-[13px] mt-1">
            {t(
              'servernew.subtitle',
              'Onboard a new host via SSH (creds discarded after use) or by generating an install command.',
            )}
          </p>
        </div>
        <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
          <Link to="/admin/servers">{t('common.cancel', 'Cancel')}</Link>
        </Button>
      </div>

      {/* Tab selector */}
      <TabBar active={tab} onChange={setTab} />

      {/* Tab panels */}
      {tab === 'ssh' ? <SshInstallForm /> : <ScriptInstallForm />}
    </div>
  )
}
