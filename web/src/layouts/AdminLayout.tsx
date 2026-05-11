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
  Plus,
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
type NavSection = { label: string; items: NavItem[] }

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid place-items-center h-[22px] w-[22px] rounded-[5px] bg-foreground text-background font-mono font-bold text-[12px]">
        Sh
      </span>
      <span className="font-semibold tracking-tight text-[14px]">Shepherd</span>
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

  const sections: NavSection[] = [
    {
      label: t('nav.section.workspace', 'Workspace'),
      items: [
        { to: '/admin/dashboard', label: t('admin.dashboard'), icon: LayoutDashboard },
        { to: '/admin/servers', label: t('admin.servers'), icon: ServerIcon },
      ],
    },
    {
      label: t('nav.section.ops', 'Operations'),
      items: [
        { to: '/admin/scripts', label: t('nav.scripts', 'Scripts'), icon: ScrollText },
        { to: '/admin/script-runs', label: t('nav.script_runs', 'Run history'), icon: PlayCircle },
        { to: '/admin/audit', label: t('nav.audit', 'Audit log'), icon: ListChecks },
      ],
    },
    {
      label: t('nav.section.system', 'System'),
      items: [
        { to: '/admin/settings', label: t('admin.settings'), icon: SettingsIcon },
      ],
    },
  ]

  const isActive = (to: string) => loc.pathname === to || loc.pathname.startsWith(to + '/')

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex flex-col gap-0.5 px-2 py-3">
      {sections.map((sec, i) => (
        <div key={sec.label} className={cn(i > 0 && 'mt-2')}>
          <div className="px-2.5 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.08em] text-fg-dim font-medium">
            {sec.label}
          </div>
          {sec.items.map((it) => {
            const active = isActive(it.to)
            return (
              <Link
                key={it.to}
                to={it.to}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 h-[30px] px-2.5 rounded-md text-[13px] transition-colors',
                  'text-muted-foreground hover:bg-sunken hover:text-foreground',
                  active && 'bg-sunken text-foreground font-medium',
                )}
              >
                <it.icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="truncate">{it.label}</span>
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )

  const onLogout = async () => {
    await logout.mutateAsync()
    navigate('/admin/login')
  }

  // Resolve current page label for breadcrumb. Lookup is best-effort —
  // unmatched routes fall back to a hyphen, which is rare since every
  // admin route lives under a known prefix.
  const crumb = (() => {
    for (const sec of sections) {
      for (const it of sec.items) {
        if (isActive(it.to)) return it.label
      }
    }
    if (loc.pathname.startsWith('/admin/servers/new')) return t('admin.add_server')
    if (loc.pathname.startsWith('/admin/files/')) return t('files.title', 'Files')
    if (loc.pathname.startsWith('/admin/recordings/')) return t('recording.title')
    return '—'
  })()

  return (
    <div className="min-h-dvh grid grid-rows-[48px_1fr] md:grid-cols-[232px_1fr] bg-background text-foreground">
      <header className="md:col-span-2 flex items-center gap-3 px-3 sm:px-4 border-b bg-elev sticky top-0 z-30">
        <div className="hidden md:flex w-[218px] pr-3.5 border-r self-stretch items-center">
          <BrandMark />
          <span className="ml-auto text-fg-dim text-[10.5px] font-mono">v0.2.1</span>
        </div>

        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden -ml-1 h-8 w-8"
              aria-label={t('nav.menu', 'Menu')}
            >
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0 sm:max-w-xs">
            <div className="px-4 py-3 border-b">
              <BrandMark />
            </div>
            <NavList onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="md:hidden">
          <BrandMark />
        </div>

        <div className="hidden md:flex items-center gap-2 text-muted-foreground text-[13px] whitespace-nowrap">
          <span>{t('admin.dashboard')}</span>
          <span className="text-fg-dim">/</span>
          <span className="text-foreground font-medium truncate max-w-[20rem]">{crumb}</span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {admin && (
            <span className="hidden sm:inline text-[12px] text-muted-foreground truncate max-w-[8rem]">
              {admin.username}
            </span>
          )}
          <Button
            asChild
            size="sm"
            variant="default"
            className="hidden sm:inline-flex h-7 px-2.5 text-[12.5px]"
          >
            <Link to="/admin/servers/new">
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t('admin.add_server')}
            </Link>
          </Button>
          <ThemeToggle />
          <LangToggle />
          <Button
            variant="ghost"
            size="icon"
            onClick={onLogout}
            aria-label={t('auth.logout')}
            className="h-8 w-8"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <aside className="hidden md:block border-r bg-elev overflow-y-auto">
        <NavList />
      </aside>

      <main className="overflow-auto bg-background min-w-0">
        <div className="px-4 sm:px-6 py-5 sm:py-6 pb-20 max-w-[1480px] mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
