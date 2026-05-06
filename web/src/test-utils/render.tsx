import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderOptions } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement, ReactNode } from 'react'
import i18n from '@/i18n'

// Ensure the shared i18n instance uses zh-CN in tests (LanguageDetector may pick 'en' in jsdom)
if (i18n.language !== 'zh-CN') {
  i18n.changeLanguage('zh-CN')
}

export function renderWithProviders(ui: ReactElement, options: RenderOptions & { initialPath?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[options.initialPath ?? '/']}>{children}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  )
  return render(ui, { wrapper: Wrapper, ...options })
}
