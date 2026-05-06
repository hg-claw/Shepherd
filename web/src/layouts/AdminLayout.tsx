import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard, Server as ServerIcon, Settings as SettingsIcon, LogOut } from 'lucide-react'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/store/auth'
import { useLogout } from '@/api/auth'
import { cn } from '@/lib/utils'

export function AdminLayout() {
  const { t } = useTranslation()
  const { admin } = useAuth()
  const logout = useLogout()
  const navigate = useNavigate()
  const loc = useLocation()

  const navItems = [
    { to: '/admin/dashboard', label: t('admin.dashboard'), icon: LayoutDashboard },
    { to: '/admin/servers', label: t('admin.servers'), icon: ServerIcon },
    { to: '/admin/settings', label: t('admin.settings'), icon: SettingsIcon },
  ]

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-r bg-card">
        <div className="px-4 py-3 font-semibold">{t('app.name')}</div>
        <nav className="px-2">
          {navItems.map((it) => {
            const active = loc.pathname.startsWith(it.to)
            return (
              <Link
                key={it.to}
                to={it.to}
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-accent',
                  active && 'bg-accent text-accent-foreground',
                )}
              >
                <it.icon className="h-4 w-4" />
                {it.label}
              </Link>
            )
          })}
        </nav>
      </aside>
      <div className="flex-1 flex flex-col">
        <header className="border-b">
          <div className="flex h-14 items-center justify-end gap-2 px-6">
            {admin && <span className="text-sm text-muted-foreground">{admin.username}</span>}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout.mutateAsync()
                navigate('/admin/login')
              }}
            >
              <LogOut className="mr-1 h-4 w-4" />
              {t('auth.logout')}
            </Button>
            <ThemeToggle />
            <LangToggle />
          </div>
        </header>
        <main className="flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
