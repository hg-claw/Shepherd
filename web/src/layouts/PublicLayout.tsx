import { Suspense } from 'react'
import { Outlet, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'

export function PublicLayout() {
  const { t } = useTranslation()
  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 h-12 border-b bg-elev">
        <div className="container flex h-full items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid place-items-center h-[22px] w-[22px] rounded-[5px] bg-foreground text-background font-mono font-bold text-[12px]">
              Sh
            </span>
            <span className="font-semibold tracking-tight text-[14px]">{t('app.name')}</span>
            <span className="text-fg-dim font-mono text-[11.5px] ml-1">/ status</span>
          </Link>
          <div className="flex items-center gap-1 sm:gap-1.5">
            <ThemeToggle />
            <LangToggle />
          </div>
        </div>
      </header>
      <main className="container flex-1 px-4 sm:px-6 py-5 sm:py-6">
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  )
}
