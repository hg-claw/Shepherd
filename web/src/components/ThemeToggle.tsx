import { Moon, Sun, Laptop } from 'lucide-react'
import { useEffect } from 'react'
import { useUI } from '@/store/ui'
import { Button } from './ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from './ui/dropdown-menu'

export function ThemeToggle() {
  const { themeMode, setTheme } = useUI()

  useEffect(() => {
    const apply = () => {
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const dark = themeMode === 'dark' || (themeMode === 'system' && sysDark)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    if (themeMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [themeMode])

  const Icon = themeMode === 'dark' ? Moon : themeMode === 'light' ? Sun : Laptop

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="theme">
          <Icon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="mr-2 h-4 w-4" /> Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="mr-2 h-4 w-4" /> Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Laptop className="mr-2 h-4 w-4" /> System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
