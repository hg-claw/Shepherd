import { Outlet, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'

export function PublicLayout() {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <Link to="/" className="font-semibold">
            {t('app.name')}
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LangToggle />
          </div>
        </div>
      </header>
      <main className="container flex-1 py-6">
        <Outlet />
      </main>
    </div>
  )
}
