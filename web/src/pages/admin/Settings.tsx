import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Pill } from '@/components/Pill'
import { useSettings, usePatchSettings } from '@/api/settings'
import { useVersion } from '@/api/version'
import { useUI } from '@/store/ui'
import { cn } from '@/lib/utils'

const schema = z.object({
  public_display_mode: z.enum(['raw', 'level', 'both']),
  retention_30s: z.string().regex(/^\d+(s|m|h|d)$/),
  retention_5m: z.string().regex(/^\d+(s|m|h|d)$/),
  retention_1h: z.string().regex(/^\d+(s|m|h|d)$/),
  default_telemetry_interval_seconds: z.coerce.number<number>().int().min(5).max(3600),
  file_sandbox_enabled: z.boolean(),
  file_sandbox_paths: z.string(),
  audit_retention_days: z.coerce.number<number>().int().min(1).max(3650),
  pty_recording_enabled: z.boolean(),
  pty_max_concurrent_per_admin: z.coerce.number<number>().int().min(1).max(64),
  file_upload_max_mb: z.coerce.number<number>().min(0.1).max(4096),
})
type FormVals = z.infer<typeof schema>

type TabKey = 'about' | 'storage' | 'keys' | 'security' | 'audit' | 'appearance'

const TABS: { key: TabKey; labelKey: string; defaultLabel: string }[] = [
  { key: 'about', labelKey: 'settings.tab.about', defaultLabel: 'About' },
  { key: 'storage', labelKey: 'settings.tab.storage', defaultLabel: 'Storage' },
  { key: 'keys', labelKey: 'settings.tab.keys', defaultLabel: 'Recovery key' },
  { key: 'security', labelKey: 'settings.tab.security', defaultLabel: 'Security & sandbox' },
  { key: 'audit', labelKey: 'settings.tab.audit', defaultLabel: 'Audit & retention' },
  { key: 'appearance', labelKey: 'settings.tab.appearance', defaultLabel: 'Appearance' },
]

export default function Settings() {
  const { t } = useTranslation()
  const settings = useSettings()
  const patch = usePatchSettings()
  const toast = useUI((s) => s.toast)
  const [tab, setTab] = useState<TabKey>('about')

  const form = useForm<FormVals>({
    resolver: zodResolver(schema),
    defaultValues: {
      public_display_mode: 'both',
      retention_30s: '24h',
      retention_5m: '7d',
      retention_1h: '90d',
      default_telemetry_interval_seconds: 30,
      file_sandbox_enabled: false,
      file_sandbox_paths: '',
      audit_retention_days: 90,
      pty_recording_enabled: false,
      pty_max_concurrent_per_admin: 5,
      file_upload_max_mb: 100,
    },
  })

  useEffect(() => {
    if (!settings.data) return
    const uploadBytes = Number(settings.data.file_upload_max_bytes ?? 104857600)
    form.reset({
      public_display_mode: (settings.data.public_display_mode as 'raw' | 'level' | 'both') ?? 'both',
      retention_30s: settings.data.retention_30s ?? '24h',
      retention_5m: settings.data.retention_5m ?? '7d',
      retention_1h: settings.data.retention_1h ?? '90d',
      default_telemetry_interval_seconds: Number(settings.data.default_telemetry_interval_seconds ?? 30),
      file_sandbox_enabled: settings.data.file_sandbox_enabled === 'true',
      file_sandbox_paths: settings.data.file_sandbox_paths ?? '',
      audit_retention_days: Number(settings.data.audit_retention_days ?? 90),
      pty_recording_enabled: settings.data.pty_recording_enabled === 'true',
      pty_max_concurrent_per_admin: Number(settings.data.pty_max_concurrent_per_admin ?? 5),
      file_upload_max_mb: uploadBytes / (1024 * 1024),
    })
  }, [settings.data, form])

  const onSubmit = form.handleSubmit(async (vals) => {
    try {
      await patch.mutateAsync({
        public_display_mode: vals.public_display_mode,
        retention_30s: vals.retention_30s,
        retention_5m: vals.retention_5m,
        retention_1h: vals.retention_1h,
        default_telemetry_interval_seconds: String(vals.default_telemetry_interval_seconds),
        file_sandbox_enabled: String(vals.file_sandbox_enabled),
        file_sandbox_paths: vals.file_sandbox_paths,
        audit_retention_days: String(vals.audit_retention_days),
        pty_recording_enabled: String(vals.pty_recording_enabled),
        pty_max_concurrent_per_admin: String(vals.pty_max_concurrent_per_admin),
        file_upload_max_bytes: String(Math.round(vals.file_upload_max_mb * 1024 * 1024)),
      })
      toast('success', t('admin.saved'))
    } catch (err: any) {
      toast('error', err?.message ?? t('common.error'))
    }
  })

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">{t('admin.settings')}</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-5 md:gap-7">
        <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible -mx-3 px-3 md:mx-0 md:px-0">
          {TABS.map((it) => (
            <button
              key={it.key}
              onClick={() => setTab(it.key)}
              className={cn(
                'text-left px-3 py-2 rounded-md text-[13px] transition-colors whitespace-nowrap',
                'text-muted-foreground hover:text-foreground hover:bg-sunken',
                tab === it.key && 'bg-sunken text-foreground font-medium',
              )}
            >
              {t(it.labelKey, it.defaultLabel)}
            </button>
          ))}
        </nav>

        <form onSubmit={onSubmit} className="min-w-0 space-y-4">
          {tab === 'about' && <AboutTab />}

          {tab === 'storage' && (
            <StorageTab register={form.register} errors={form.formState.errors} />
          )}

          {tab === 'keys' && <KeysTab />}

          {tab === 'security' && (
            <SecurityTab form={form} />
          )}

          {tab === 'audit' && (
            <AuditTab register={form.register} errors={form.formState.errors} />
          )}

          {tab === 'appearance' && <AppearanceTab />}

          {tab !== 'about' && tab !== 'keys' && tab !== 'appearance' && (
            <div className="pt-2">
              <Button type="submit" className="w-full sm:w-auto h-8">
                {t('admin.save')}
              </Button>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3.5 py-3 border-b border-dashed">
      <span className="text-muted-foreground text-[12.5px]">{k}</span>
      <span className="font-mono text-[12.5px]">{v}</span>
    </div>
  )
}

function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div>
      <h3 className="text-[13px] font-semibold m-0 mb-1">{children}</h3>
      {sub && <p className="text-muted-foreground text-[12px] m-0 mb-2.5">{sub}</p>}
    </div>
  )
}

function AboutTab() {
  const versionQ = useVersion()
  return (
    <div>
      <SectionTitle>About this install</SectionTitle>
      <div className="border rounded-lg bg-elev px-4 py-1">
        <KV k="Version" v={versionQ.data?.version ?? '…'} />
        <KV
          k="Admin"
          v={<span>admin (single-user)</span>}
        />
        <KV k="Database" v="set via DATABASE_URL — see Storage" />
        <KV k="Public wall" v={<span>enabled · /</span>} />
      </div>
      <p className="text-muted-foreground text-[12px] mt-3">
        Workspace name, default channels, timezone, and team membership are not configurable in
        this release.
      </p>
    </div>
  )
}

function StorageTab({
  register,
  errors,
}: {
  register: ReturnType<typeof useForm<FormVals>>['register']
  errors: Record<string, { message?: string } | undefined>
}) {
  return (
    <div className="space-y-5">
      <div>
        <SectionTitle sub="Set DATABASE_URL=postgres://… and restart to migrate to Postgres.">
          Database
        </SectionTitle>
        <div className="border rounded-lg bg-elev px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <Pill kind="ok">SQLite</Pill>
            <span className="font-mono text-[12px] text-muted-foreground truncate">
              configured via SHEPHERD_DSN or default ./shepherd.db
            </span>
          </div>
        </div>
      </div>

      <div>
        <SectionTitle sub="How long to keep each rollup bucket. Older points get pruned every hour.">
          Retention
        </SectionTitle>
        <div className="border rounded-lg bg-elev overflow-hidden">
          <RetentionRow
            label="raw"
            desc="raw samples at the agent interval"
            register={register('retention_30s')}
            error={errors.retention_30s?.message}
          />
          <RetentionRow
            label="5m"
            desc="downsample → 5m bucket every 5m"
            register={register('retention_5m')}
            error={errors.retention_5m?.message}
          />
          <RetentionRow
            label="1h"
            desc="downsample → 1h bucket hourly"
            register={register('retention_1h')}
            error={errors.retention_1h?.message}
          />
        </div>
      </div>

      <div>
        <SectionTitle>Default telemetry interval</SectionTitle>
        <div className="border rounded-lg bg-elev px-4 py-3.5">
          <div className="flex items-center gap-3">
            <Input
              type="number"
              {...register('default_telemetry_interval_seconds')}
              className="w-28 h-8 font-mono"
            />
            <span className="text-muted-foreground text-[12px]">seconds (5 – 3600)</span>
          </div>
          {errors.default_telemetry_interval_seconds?.message && (
            <p className="text-xs text-destructive mt-1">
              {errors.default_telemetry_interval_seconds.message}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function KeysTab() {
  return (
    <div>
      <SectionTitle sub="Pre-shared, server-global. Embedded into agent config at install time so an agent can re-enroll after a fingerprint change (disk swap, container rebuild). View / rotate from the server CLI for now.">
        Recovery key (AUTO_RECOVER_KEY)
      </SectionTitle>
      <div className="border rounded-lg bg-elev px-4 py-3.5 space-y-3">
        <code className="block bg-sunken rounded-md border px-3 py-2.5 font-mono text-[12px] text-muted-foreground break-all">
          configured via AUTO_RECOVER_KEY env var; not exposed over the admin API
        </code>
        <p className="text-fg-dim text-[12px]">
          To rotate: stop the server, change AUTO_RECOVER_KEY, restart. Agents pick up the new
          value on their next reconnect.
        </p>
      </div>
    </div>
  )
}

function SecurityTab({ form }: { form: ReturnType<typeof useForm<FormVals>> }) {
  const sandboxOn = form.watch('file_sandbox_enabled')
  const ptyRec = form.watch('pty_recording_enabled')
  return (
    <div className="space-y-5">
      <div>
        <SectionTitle sub="The remote file browser is restricted to these paths. Outside paths return 403 even with sudo.">
          File browser sandbox
        </SectionTitle>
        <div className="border rounded-lg bg-elev p-4 space-y-3">
          <ToggleRow
            label="Enable sandbox"
            hint="Disabling exposes the entire filesystem to admin sessions."
            value={sandboxOn}
            onChange={(v) => form.setValue('file_sandbox_enabled', v)}
          />
          <div>
            <Label className="text-[12px]">Allowed paths (one per line)</Label>
            <textarea
              className="mt-1 w-full min-h-[110px] rounded-md border border-input bg-background px-3 py-2 text-[13px] font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="/var/log&#10;/etc/shepherd"
              {...form.register('file_sandbox_paths')}
            />
          </div>
          <NumberRow
            label="Max upload size"
            suffix="MB"
            min={0.1}
            max={4096}
            step={0.1}
            register={form.register('file_upload_max_mb')}
            error={form.formState.errors.file_upload_max_mb?.message}
          />
        </div>
      </div>

      <div>
        <SectionTitle>PTY sessions</SectionTitle>
        <div className="border rounded-lg bg-elev p-4 space-y-3">
          <ToggleRow
            label="Record PTY sessions"
            hint="Records every key and output line as asciinema for replay."
            value={ptyRec}
            onChange={(v) => form.setValue('pty_recording_enabled', v)}
          />
          <NumberRow
            label="Max concurrent PTY sessions per admin"
            min={1}
            max={64}
            register={form.register('pty_max_concurrent_per_admin')}
            error={form.formState.errors.pty_max_concurrent_per_admin?.message}
          />
        </div>
      </div>
    </div>
  )
}

function AuditTab({
  register,
  errors,
}: {
  register: ReturnType<typeof useForm<FormVals>>['register']
  errors: Record<string, { message?: string } | undefined>
}) {
  return (
    <div>
      <SectionTitle sub="Audit events cover PTY sessions, file uploads/downloads, batch runs, and settings changes.">
        Retention
      </SectionTitle>
      <div className="border rounded-lg bg-elev p-4 space-y-3">
        <NumberRow
          label="Retain audit events"
          suffix="days"
          min={1}
          max={3650}
          register={register('audit_retention_days')}
          error={errors.audit_retention_days?.message}
        />
        <p className="text-fg-dim text-[12px]">
          PTY recordings are pruned alongside their session row; storage used is reported in the
          server logs.
        </p>
      </div>
    </div>
  )
}

function AppearanceTab() {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-[12.5px]">
        {t(
          'settings.appearance_hint',
          'Theme and language live in the top bar so you can change them on any page.',
        )}
      </p>
    </div>
  )
}

function RetentionRow({
  label,
  desc,
  register,
  error,
}: {
  label: string
  desc: string
  register: ReturnType<ReturnType<typeof useForm<FormVals>>['register']>
  error?: string
}) {
  return (
    <div className="flex items-center px-4 py-3 border-b last:border-b-0 gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-[13px]">{label}</div>
        <div className="text-fg-dim font-mono text-[11.5px]">{desc}</div>
      </div>
      <Input {...register} className="w-24 h-8 font-mono text-[12.5px]" />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3 py-1">
      <div className="flex-1">
        <div className="font-medium text-[13px]">{label}</div>
        {hint && <div className="text-fg-dim text-[12px]">{hint}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={cn(
          'px-3 h-7 rounded-full border text-[12px] font-mono transition-colors shrink-0',
          value
            ? 'bg-accent text-accent-foreground border-transparent'
            : 'bg-sunken text-muted-foreground hover:text-foreground',
        )}
      >
        {value ? 'on' : 'off'}
      </button>
    </div>
  )
}

function NumberRow({
  label,
  suffix,
  min,
  max,
  step,
  register,
  error,
}: {
  label: string
  suffix?: string
  min?: number
  max?: number
  step?: number
  register: ReturnType<ReturnType<typeof useForm<FormVals>>['register']>
  error?: string
}) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="flex-1 font-medium text-[13px]">{label}</div>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        {...register}
        className="w-24 h-8 font-mono text-[12.5px]"
      />
      {suffix && <span className="text-fg-dim text-[12px] font-mono w-12">{suffix}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
