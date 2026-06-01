import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './index.css'
import './i18n'
import i18n from './i18n'
import { useUI } from './store/ui'
import { setOn401 } from './api/client'
import { useAuth } from './store/auth'
import { Toaster } from './components/ui/toaster'
import { installChunkReload } from './lib/chunkReload'

// Recover from stale lazy-chunk imports after a redeploy. Registered before
// any route lazy-loads so the very first failed import is caught.
installChunkReload()

const stored = useUI.getState().lang
i18n.changeLanguage(stored)

// Subscribe theme mode → html.dark class. The pre-mount script in index.html
// handles the initial paint; this keeps the class in sync after the user
// flips the toggle or the system preference changes in 'system' mode.
function applyTheme(mode: 'system' | 'light' | 'dark') {
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', mode === 'dark' || (mode === 'system' && sysDark))
}
applyTheme(useUI.getState().themeMode)
useUI.subscribe((s, prev) => {
  if (s.themeMode !== prev.themeMode) applyTheme(s.themeMode)
})
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (useUI.getState().themeMode === 'system') applyTheme('system')
})

setOn401(() => {
  useAuth.getState().clear()
  if (window.location.pathname.startsWith('/admin') && window.location.pathname !== '/admin/login') {
    window.location.assign('/admin/login')
  }
})

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
