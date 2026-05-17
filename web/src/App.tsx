import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
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
import ScriptsListPage from './pages/admin/ScriptsListPage'
import ScriptEditPage from './pages/admin/ScriptEditPage'
import ScriptRunPage from './pages/admin/ScriptRunPage'
import ScriptRunsPage from './pages/admin/ScriptRunsPage'
import ScriptRunDetailPage from './pages/admin/ScriptRunDetailPage'
import FileBrowserPage from './pages/admin/FileBrowserPage'
import FilesHubPage from './pages/admin/FilesHubPage'
import PluginsIndex from './pages/admin/plugins'
import AuditLogPage from './pages/admin/AuditLogPage'
import RecordingPlayerPage from './pages/admin/RecordingPlayerPage'
import { ConsoleDock } from './components/ConsoleDock'

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
          <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="/admin/dashboard" element={<Dashboard />} />
          <Route path="/admin/servers" element={<ServerList />} />
          <Route path="/admin/servers/new" element={<ServerNew />} />
          <Route path="/admin/servers/:id" element={<AdminServerDetail />} />
          <Route path="/admin/settings" element={<Settings />} />
          <Route path="/admin/scripts" element={<ScriptsListPage />} />
          <Route path="/admin/scripts/new" element={<ScriptEditPage mode="create" />} />
          <Route path="/admin/scripts/:id" element={<ScriptEditPage mode="edit" />} />
          <Route path="/admin/scripts/:id/run" element={<ScriptRunPage />} />
          <Route path="/admin/script-runs" element={<ScriptRunsPage />} />
          <Route path="/admin/script-runs/:id" element={<ScriptRunDetailPage />} />
          <Route path="/admin/files" element={<FilesHubPage />} />
          <Route path="/admin/files/:serverId" element={<FileBrowserPage />} />
          <Route path="/admin/plugins" element={<PluginsIndex />} />
          <Route path="/admin/audit" element={<AuditLogPage />} />
          <Route path="/admin/recordings/:id" element={<RecordingPlayerPage />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
      <ConsoleDock />
    </Suspense>
  )
}
