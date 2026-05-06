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
import { useSettings, usePatchSettings } from '@/api/settings'
import { useUI } from '@/store/ui'

const schema = z.object({
  public_display_mode: z.enum(['raw', 'level', 'both']),
  retention_30s: z.string().regex(/^\d+(s|m|h|d)$/),
  retention_5m: z.string().regex(/^\d+(s|m|h|d)$/),
  retention_1h: z.string().regex(/^\d+(s|m|h|d)$/),
  default_telemetry_interval_seconds: z.coerce.number<number>().int().min(5).max(3600),
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
    },
  })

  // Hydrate when settings load.
  useEffect(() => {
    if (!settings.data) return
    reset({
      public_display_mode: (settings.data.public_display_mode as 'raw' | 'level' | 'both') ?? 'both',
      retention_30s: settings.data.retention_30s ?? '24h',
      retention_5m: settings.data.retention_5m ?? '7d',
      retention_1h: settings.data.retention_1h ?? '90d',
      default_telemetry_interval_seconds: Number(settings.data.default_telemetry_interval_seconds ?? 30),
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
      })
      toast('success', t('admin.saved'))
    } catch (err: any) {
      toast('error', err?.message ?? t('common.error'))
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('admin.settings')}</h1>
      <Card>
        <CardHeader><CardTitle>{t('admin.settings')}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 max-w-md">
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
