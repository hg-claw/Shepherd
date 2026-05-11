import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useSettings, usePatchSettings } from '@/api/settings'
import { useUI } from '@/store/ui'

const schema = z.object({
  public_display_mode: z.enum(['raw', 'level', 'both']),
  retention_30s: z.string().regex(/^\d+(s|m|h|d)$/),
  retention_5m: z.string().regex(/^\d+(s|m|h|d)$/),
  retention_1h: z.string().regex(/^\d+(s|m|h|d)$/),
  default_telemetry_interval_seconds: z.coerce.number<number>().int().min(5).max(3600),
  // Phase 2 fields
  file_sandbox_enabled: z.boolean(),
  file_sandbox_paths: z.string(),
  audit_retention_days: z.coerce.number<number>().int().min(1),
  pty_recording_enabled: z.boolean(),
  pty_max_concurrent_per_admin: z.coerce.number<number>().int().min(1),
  file_upload_max_mb: z.coerce.number<number>().min(0.1),
})
type FormVals = z.infer<typeof schema>

export default function Settings() {
  const { t } = useTranslation()
  const settings = useSettings()
  const patch = usePatchSettings()
  const toast = useUI((s) => s.toast)

  const { register, handleSubmit, setValue, watch, formState: { errors }, reset } = useForm<FormVals>({
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

  // Hydrate when settings load.
  useEffect(() => {
    if (!settings.data) return
    const uploadBytes = Number(settings.data.file_upload_max_bytes ?? 104857600)
    reset({
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
  }, [settings.data, reset])

  const mode = watch('public_display_mode')

  const onSubmit = async (vals: FormVals) => {
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
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">{t('admin.settings')}</h1>
      <Card>
        <CardHeader><CardTitle>{t('admin.settings')}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 max-w-full sm:max-w-md">
            <div className="space-y-1">
              <Label>{t('settings.public_display_mode')}</Label>
              <Select value={mode} onValueChange={(v) => setValue('public_display_mode', v as 'raw' | 'level' | 'both')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="raw">{t('settings.mode_raw')}</SelectItem>
                  <SelectItem value="level">{t('settings.mode_level')}</SelectItem>
                  <SelectItem value="both">{t('settings.mode_both')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Field label={t('settings.retention_30s')} {...register('retention_30s')} error={errors.retention_30s?.message} />
            <Field label={t('settings.retention_5m')} {...register('retention_5m')} error={errors.retention_5m?.message} />
            <Field label={t('settings.retention_1h')} {...register('retention_1h')} error={errors.retention_1h?.message} />
            <Field
              label={t('settings.default_telemetry_interval_seconds')}
              type="number"
              {...register('default_telemetry_interval_seconds')}
              error={errors.default_telemetry_interval_seconds?.message}
            />
            <div className="pt-4 border-t">
              <p className="text-sm font-semibold mb-3">{t('settings.phase2_header')}</p>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Switch
                    id="file_sandbox_enabled"
                    checked={watch('file_sandbox_enabled')}
                    onCheckedChange={(v) => setValue('file_sandbox_enabled', v)}
                  />
                  <Label htmlFor="file_sandbox_enabled">{t('settings.file_sandbox_enabled')}</Label>
                </div>
                <div className="space-y-1">
                  <Label>{t('settings.file_sandbox_paths')}</Label>
                  <textarea
                    className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    placeholder="/var/www&#10;/home"
                    {...register('file_sandbox_paths')}
                  />
                </div>
                <Field
                  label={t('settings.audit_retention_days')}
                  type="number"
                  {...register('audit_retention_days')}
                  error={errors.audit_retention_days?.message}
                />
                <div className="flex items-center gap-2">
                  <Switch
                    id="pty_recording_enabled"
                    checked={watch('pty_recording_enabled')}
                    onCheckedChange={(v) => setValue('pty_recording_enabled', v)}
                  />
                  <Label htmlFor="pty_recording_enabled">{t('settings.pty_recording_enabled')}</Label>
                </div>
                <Field
                  label={t('settings.pty_max_concurrent_per_admin')}
                  type="number"
                  {...register('pty_max_concurrent_per_admin')}
                  error={errors.pty_max_concurrent_per_admin?.message}
                />
                <Field
                  label={t('settings.file_upload_max_mb')}
                  type="number"
                  step="0.1"
                  {...register('file_upload_max_mb')}
                  error={errors.file_upload_max_mb?.message}
                />
              </div>
            </div>
            <Button type="submit">{t('admin.save')}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function Field({
  label,
  error,
  ...rest
}: {
  label: string
  error?: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input {...rest} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
