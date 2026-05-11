import { Outlet, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'

export function PublicLayout() {
  const { t } = useTranslation()
  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="container flex h-14 items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 font-mono">
            <span
              className="inline-block h-2 w-2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--glow-primary)/0.7)]"
              aria-hidden
            />
            <span className="text-muted-foreground text-sm">[</span>
            <span className="text-sm font-semibold tracking-[0.18em] uppercase">{t('app.name')}</span>
            <span className="text-muted-foreground text-sm">]</span>
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <LangToggle />
          </div>
        </div>
      </header>
      <main className="container flex-1 px-4 sm:px-6 py-4 sm:py-6">
        <Outlet />
      </main>
    </div>
  )
}
