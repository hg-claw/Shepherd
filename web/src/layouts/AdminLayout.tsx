import { useState } from 'react'
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard,
  Server as ServerIcon,
  Settings as SettingsIcon,
  LogOut,
  Menu,
  ScrollText,
  PlayCircle,
  ListChecks,
} from 'lucide-react'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { useAuth } from '@/store/auth'
import { useLogout } from '@/api/auth'
import { cn } from '@/lib/utils'

type NavItem = {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

function BrandMark({ name }: { name: string }) {
  return (
    <div className="px-4 py-3 flex items-center gap-2 font-mono">
      <span className="inline-block h-2 w-2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--glow-primary)/0.7)]" aria-hidden />
      <span className="text-muted-foreground text-sm">[</span>
      <span className="text-sm font-semibold tracking-[0.18em] uppercase">{name}</span>
      <span className="text-muted-foreground text-sm">]</span>
    </div>
  )
}

export function AdminLayout() {
  const { t } = useTranslation()
  const { admin } = useAuth()
  const logout = useLogout()
  const navigate = useNavigate()
  const loc = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const navItems: NavItem[] = [
    { to: '/admin/dashboard', label: t('admin.dashboard'), icon: LayoutDashboard },
    { to: '/admin/servers', label: t('admin.servers'), icon: ServerIcon },
    { to: '/admin/scripts', label: t('nav.scripts', 'Scripts'), icon: ScrollText },
    { to: '/admin/script-runs', label: t('nav.script_runs', 'Run history'), icon: PlayCircle },
    { to: '/admin/audit', label: t('nav.audit', 'Audit log'), icon: ListChecks },
    { to: '/admin/settings', label: t('admin.settings'), icon: SettingsIcon },
  ]

  const isActive = (to: string) => loc.pathname === to || loc.pathname.startsWith(to + '/')

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="px-2 py-2 space-y-0.5">
      {navItems.map((it) => {
        const active = isActive(it.to)
        return (
          <Link
            key={it.to}
            to={it.to}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative flex items-center gap-2 rounded px-2 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
              active && 'bg-accent text-accent-foreground font-medium',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'absolute left-0 top-1/2 h-5 -translate-y-1/2 w-0.5 rounded-r bg-primary transition-opacity',
                active ? 'opacity-100 dark:shadow-[0_0_8px_hsl(var(--glow-primary)/0.7)]' : 'opacity-0',
              )}
            />
            <it.icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{it.label}</span>
          </Link>
        )
      })}
    </nav>
  )

  const onLogout = async () => {
    await logout.mutateAsync()
    navigate('/admin/login')
  }

  return (
    <div className="min-h-dvh flex bg-background text-foreground">
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r bg-card">
        <BrandMark name={t('app.name')} />
        <NavList />
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          <div className="flex h-14 items-center gap-2 px-3 sm:px-6">
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden -ml-2"
                  aria-label={t('nav.menu', 'Menu')}
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-64 p-0 sm:max-w-xs">
                <div className="border-b">
                  <BrandMark name={t('app.name')} />
                </div>
                <NavList onNavigate={() => setDrawerOpen(false)} />
              </SheetContent>
            </Sheet>

            <div className="md:hidden truncate font-mono text-sm">
              <span className="text-muted-foreground">[</span>
              <span className="mx-1 font-semibold tracking-wider">{t('app.name')}</span>
              <span className="text-muted-foreground">]</span>
            </div>

            <div className="ml-auto flex items-center gap-1 sm:gap-2">
              {admin && (
                <span className="hidden sm:inline text-sm text-muted-foreground truncate max-w-[10rem]">
                  {admin.username}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={onLogout}
                aria-label={t('auth.logout')}
                className="px-2 sm:px-3"
              >
                <LogOut className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">{t('auth.logout')}</span>
              </Button>
              <ThemeToggle />
              <LangToggle />
            </div>
          </div>
        </header>
        <main className="flex-1 px-3 sm:px-6 py-4 sm:py-6 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
