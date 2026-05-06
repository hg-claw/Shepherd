import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export function NotFound() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">{t('common.not_found')}</p>
      <Link to="/" className="text-primary underline">
        {t('common.back')}
      </Link>
    </div>
  )
}

export default NotFound
