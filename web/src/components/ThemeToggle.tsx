import { Moon, Sun, Laptop } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUI } from '@/store/ui'
import { Button } from './ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from './ui/dropdown-menu'

export function ThemeToggle() {
  const { t } = useTranslation()
  const { themeMode, setTheme } = useUI()
  const Icon = themeMode === 'dark' ? Moon : themeMode === 'light' ? Sun : Laptop

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('theme.label', 'Theme')}>
          <Icon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="mr-2 h-4 w-4" />
          {themeMode === 'light' ? '✓ ' : ''}
          {t('theme.light', 'Light')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="mr-2 h-4 w-4" />
          {themeMode === 'dark' ? '✓ ' : ''}
          {t('theme.dark', 'Dark')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Laptop className="mr-2 h-4 w-4" />
          {themeMode === 'system' ? '✓ ' : ''}
          {t('theme.system', 'System')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
