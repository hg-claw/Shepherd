import { useTranslation } from 'react-i18next'

export default function ActivityTab() {
  const { t } = useTranslation()
  return (
    <div className="text-sm text-muted-foreground">
      {t('cloudflare.activity.body_pre', 'Cloudflare audit log integration is tracked separately — this tab will surface the most recent events once the')}{' '}
      <code>GET /audit</code>{' '}
      {t('cloudflare.activity.body_post', 'endpoint is wired up.')}
    </div>
  )
}
