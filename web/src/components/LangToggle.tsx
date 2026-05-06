import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUI } from '@/store/ui'
import { Button } from './ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from './ui/dropdown-menu'

export function LangToggle() {
  const { lang, setLang } = useUI()
  const { i18n } = useTranslation()

  const change = (l: 'zh-CN' | 'en') => {
    setLang(l)
    i18n.changeLanguage(l)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="language">
          <Languages className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => change('zh-CN')}>
          {lang === 'zh-CN' ? '✓ ' : ''}中文
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => change('en')}>
          {lang === 'en' ? '✓ ' : ''}English
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
