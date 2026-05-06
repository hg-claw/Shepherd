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
import { Toaster as ShadcnToaster } from './components/ui/toaster'
import { ToastBridge } from './components/ToastBridge'

const stored = useUI.getState().lang
i18n.changeLanguage(stored)

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
        <ShadcnToaster />
        <ToastBridge />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
