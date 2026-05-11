import { useState } from 'react'
import { Outlet, Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard,
  Server as ServerIcon,
  Settings as SettingsIcon,
  LogOut,
  Menu,
  Plus,
  PlayCircle,
  FolderTree,
  Puzzle,
  Globe,
} from 'lucide-react'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { useAuth } from '@/store/auth'
import { useLogout } from '@/api/auth'
import { useServers } from '@/api/servers'
import { useRecentHosts } from '@/hooks/use-recent-hosts'
import { cn } from '@/lib/utils'

type NavItem = {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  badge?: number
  external?: boolean
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
  const params = useParams()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const recentIds = useRecentHosts()
  const serversQuery = useServers({ refetchInterval: 60_000 })
  const recents = recentIds
    .map((id) => serversQuery.data?.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
  const hostCount = serversQuery.data?.length

  const sections: NavSection[] = [
    {
      label: t('nav.section.workspace', 'Workspace'),
      items: [
        { to: '/admin/dashboard', label: t('nav.overview', 'Overview'), icon: LayoutDashboard },
        {
          to: '/admin/servers',
          label: t('nav.hosts', 'Hosts'),
          icon: ServerIcon,
          badge: hostCount,
        },
        { to: '/admin/servers/new', label: t('admin.add_server'), icon: Plus },
        { to: '/', label: t('nav.public_wall', 'Public wall'), icon: Globe, external: true },
      ],
    },
    {
      label: t('nav.section.ops', 'Operations'),
      items: [
        { to: '/admin/scripts', label: t('nav.batch', 'Batch'), icon: PlayCircle },
        { to: '/admin/files', label: t('nav.files', 'Files'), icon: FolderTree },
        { to: '/admin/plugins', label: t('nav.plugins', 'Plugins'), icon: Puzzle },
        { to: '/admin/settings', label: t('admin.settings'), icon: SettingsIcon },
      ],
    },
  ]

  const isActive = (to: string) => {
    if (to === '/') return false // Public wall is a separate site; never "active" in admin nav
    return loc.pathname === to || loc.pathname.startsWith(to + '/')
  }

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex flex-col gap-0.5 px-2 py-3">
      {sections.map((sec, i) => (
        <div key={sec.label} className={cn(i > 0 && 'mt-2')}>
          <div className="px-2.5 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.08em] text-fg-dim font-medium">
            {sec.label}
          </div>
          {sec.items.map((it) => {
            const active = isActive(it.to)
            const cls = cn(
              'flex items-center gap-2.5 h-[30px] px-2.5 rounded-md text-[13px] transition-colors',
              'text-muted-foreground hover:bg-sunken hover:text-foreground',
              active && 'bg-sunken text-foreground font-medium',
            )
            const body = (
              <>
                <it.icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="truncate flex-1">{it.label}</span>
                {it.badge != null && (
                  <span className="text-fg-dim text-[11px] font-mono">{it.badge}</span>
                )}
              </>
            )
            if (it.external) {
              return (
                <a
                  key={it.to}
                  href={it.to}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onNavigate}
                  className={cls}
                >
                  {body}
                </a>
              )
            }
            return (
              <Link
                key={it.to}
                to={it.to}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cls}
              >
                {body}
              </Link>
            )
          })}
        </div>
      ))}

      <div className="mt-2">
        <div className="px-2.5 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.08em] text-fg-dim font-medium">
          {t('nav.section.recent', 'Recent hosts')}
        </div>
        {recents.length === 0 ? (
          <div className="px-2.5 py-1.5 text-fg-dim text-[11.5px] font-mono">
            {t('nav.recent_empty', 'visit a host to see it here')}
          </div>
        ) : (
          recents.map((s) => {
            const online =
              s.agent_last_seen?.Valid &&
              Date.now() - new Date(s.agent_last_seen.Time).getTime() <= 90_000
            return (
              <Link
                key={s.id}
                to={`/admin/servers/${s.id}`}
                onClick={onNavigate}
                className="flex items-center gap-2.5 h-[28px] px-2.5 rounded-md text-[12.5px] font-mono text-muted-foreground hover:bg-sunken hover:text-foreground transition-colors"
              >
                <span
                  className={cn(
                    'inline-block h-1.5 w-1.5 rounded-full shrink-0',
                    online ? 'bg-ok' : 'bg-fg-dim',
                  )}
                />
                <span className="truncate">{s.name}</span>
              </Link>
            )
          })
        )}
      </div>
    </nav>
  )

  const onLogout = async () => {
    await logout.mutateAsync()
    navigate('/admin/login')
  }

  // Breadcrumb (3 levels max): Dashboard / <section> / <leaf>. The leaf is
  // present on host detail pages where the URL has a numeric :id, on script
  // run detail pages, and on file browser pages — anywhere a sub-resource
  // identity adds context the section label can't show on its own.
  type Crumb = { label: string; to?: string }
  const crumbs: Crumb[] = (() => {
    const path = loc.pathname
    const out: Crumb[] = [{ label: t('admin.dashboard'), to: '/admin/dashboard' }]
    if (path === '/admin/dashboard' || path === '/admin' || path === '/admin/') {
      return out
    }
    if (path.startsWith('/admin/servers')) {
      out.push({ label: t('nav.hosts', 'Hosts'), to: '/admin/servers' })
      if (path === '/admin/servers/new') {
        out.push({ label: t('admin.add_server') })
      } else if (params.id || /^\/admin\/servers\/\d+/.test(path)) {
        const id = Number(path.split('/')[3])
        const s = serversQuery.data?.find((sv) => sv.id === id)
        out.push({ label: s?.name ?? `#${id}` })
      }
      return out
    }
    if (path.startsWith('/admin/scripts')) {
      out.push({ label: t('nav.batch', 'Batch'), to: '/admin/scripts' })
      if (path.match(/^\/admin\/scripts\/\d+\/run$/)) {
        out.push({ label: t('scripts.run', 'Run') })
      } else if (path === '/admin/scripts/new') {
        out.push({ label: t('scripts.new', 'New') })
      } else if (path.match(/^\/admin\/scripts\/\d+/)) {
        out.push({ label: t('scripts.edit', 'Edit') })
      }
      return out
    }
    if (path.startsWith('/admin/script-runs')) {
      out.push({ label: t('nav.script_runs', 'Run history') })
      if (path.match(/^\/admin\/script-runs\/\d+/)) {
        out.push({ label: '#' + path.split('/')[3] })
      }
      return out
    }
    if (path.startsWith('/admin/files')) {
      out.push({ label: t('nav.files', 'Files'), to: '/admin/files' })
      const m = path.match(/^\/admin\/files\/(\d+)/)
      if (m) {
        const id = Number(m[1])
        const s = serversQuery.data?.find((sv) => sv.id === id)
        out.push({ label: s?.name ?? `#${id}` })
      }
      return out
    }
    if (path.startsWith('/admin/audit')) {
      out.push({ label: t('audit.title') })
      return out
    }
    if (path.startsWith('/admin/plugins')) {
      out.push({ label: t('nav.plugins', 'Plugins') })
      return out
    }
    if (path.startsWith('/admin/settings')) {
      out.push({ label: t('admin.settings') })
      return out
    }
    if (path.startsWith('/admin/recordings')) {
      out.push({ label: t('recording.title') })
      return out
    }
    return out
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

        <div className="hidden md:flex items-center gap-2 text-muted-foreground text-[13px] whitespace-nowrap min-w-0 flex-1">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={i} className="flex items-center gap-2 min-w-0">
                {i > 0 && <span className="text-fg-dim shrink-0">/</span>}
                {c.to && !last ? (
                  <Link
                    to={c.to}
                    className="hover:text-foreground transition-colors truncate"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span
                    className={cn(
                      'truncate max-w-[16rem]',
                      last && 'text-foreground font-medium',
                    )}
                  >
                    {c.label}
                  </span>
                )}
              </span>
            )
          })}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
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
          {admin && (
            <span
              title={admin.username}
              className="grid place-items-center h-7 w-7 rounded-full bg-sunken border text-[11px] font-mono uppercase shrink-0"
            >
              {admin.username.slice(0, 1)}
            </span>
          )}
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
