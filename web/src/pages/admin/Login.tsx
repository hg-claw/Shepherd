import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useLogin } from '@/api/auth'
import { useAuth } from '@/store/auth'
import { useUI } from '@/store/ui'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})
type FormVals = z.infer<typeof schema>

export default function Login() {
  const { t } = useTranslation()
  const login = useLogin()
  const setAdmin = useAuth((s) => s.setAdmin)
  const toast = useUI((s) => s.toast)
  const navigate = useNavigate()
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormVals>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '' },
  })

  const onSubmit = async (vals: FormVals) => {
    try {
      const admin = await login.mutateAsync(vals)
      setAdmin(admin)
      navigate('/admin/dashboard')
    } catch (err: any) {
      const msg = err?.status === 401 ? t('auth.invalid_credentials') : err?.message ?? t('common.error')
      toast('error', msg)
    }
  }

  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between px-4 sm:px-6">
          <span className="flex items-center gap-2 font-mono">
            <span
              className="inline-block h-2 w-2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--glow-primary)/0.7)]"
              aria-hidden
            />
            <span className="text-muted-foreground text-sm">[</span>
            <span className="text-sm font-semibold tracking-[0.18em] uppercase">{t('app.name')}</span>
            <span className="text-muted-foreground text-sm">]</span>
          </span>
          <div className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <LangToggle />
          </div>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>{t('auth.login')}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">{t('auth.username')}</Label>
                <Input id="username" autoComplete="username" {...register('username')} />
                {errors.username && <p className="text-xs text-destructive">{errors.username.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t('auth.password')}</Label>
                <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
                {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
              </div>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {t('auth.submit')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
