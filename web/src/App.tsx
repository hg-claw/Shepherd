import { Suspense, lazy } from 'react'
import { Routes, Route } from 'react-router-dom'
import { RequireAdmin } from './components/RequireAdmin'

const Wall = lazy(() => import('./pages/public/Wall'))
const PublicServerDetail = lazy(() => import('./pages/public/ServerDetail'))
const Login = lazy(() => import('./pages/admin/Login'))
const Dashboard = lazy(() => import('./pages/admin/Dashboard'))
const ServerList = lazy(() => import('./pages/admin/ServerList'))
const ServerNew = lazy(() => import('./pages/admin/ServerNew'))
const AdminServerDetail = lazy(() => import('./pages/admin/ServerDetail'))
const Settings = lazy(() => import('./pages/admin/Settings'))
const NotFound = lazy(() => import('./pages/NotFound'))

import { PublicLayout } from './layouts/PublicLayout'
import { AdminLayout } from './layouts/AdminLayout'

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route path="/" element={<Wall />} />
          <Route path="/public/servers/:id" element={<PublicServerDetail />} />
        </Route>

        <Route path="/admin/login" element={<Login />} />

        <Route
          element={
            <RequireAdmin>
              <AdminLayout />
            </RequireAdmin>
          }
        >
          <Route path="/admin/dashboard" element={<Dashboard />} />
          <Route path="/admin/servers" element={<ServerList />} />
          <Route path="/admin/servers/new" element={<ServerNew />} />
          <Route path="/admin/servers/:id" element={<AdminServerDetail />} />
          <Route path="/admin/settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}
