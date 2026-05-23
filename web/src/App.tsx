import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { RequireAdmin } from './components/RequireAdmin'

// All route components are lazy — keeps the initial bundle to just
// React + router + the layouts. Pre-fix the static imports below were
// dragging Scripts*, Files*, Audit, Recording, Plugins (and their
// recharts / asciinema / xterm transitive deps) into the index chunk,
// pushing it past 1.4MB raw before gzip.
const Wall = lazy(() => import('./pages/public/Wall'))
const PublicServerDetail = lazy(() => import('./pages/public/ServerDetail'))
const Login = lazy(() => import('./pages/admin/Login'))
const Dashboard = lazy(() => import('./pages/admin/Dashboard'))
const ServerList = lazy(() => import('./pages/admin/ServerList'))
const ServerNew = lazy(() => import('./pages/admin/ServerNew'))
const AdminServerDetail = lazy(() => import('./pages/admin/ServerDetail'))
const Settings = lazy(() => import('./pages/admin/Settings'))
const PluginDetail = lazy(() => import('./pages/admin/plugins/detail'))
const PluginsIndex = lazy(() => import('./pages/admin/plugins'))
const ScriptsListPage = lazy(() => import('./pages/admin/ScriptsListPage'))
const ScriptEditPage = lazy(() => import('./pages/admin/ScriptEditPage'))
const ScriptRunPage = lazy(() => import('./pages/admin/ScriptRunPage'))
const ScriptRunsPage = lazy(() => import('./pages/admin/ScriptRunsPage'))
const ScriptRunDetailPage = lazy(() => import('./pages/admin/ScriptRunDetailPage'))
const FileBrowserPage = lazy(() => import('./pages/admin/FileBrowserPage'))
const FilesHubPage = lazy(() => import('./pages/admin/FilesHubPage'))
const AuditLogPage = lazy(() => import('./pages/admin/AuditLogPage'))
const RecordingPlayerPage = lazy(() => import('./pages/admin/RecordingPlayerPage'))
const NotFound = lazy(() => import('./pages/NotFound'))

import { PublicLayout } from './layouts/PublicLayout'
import { AdminLayout } from './layouts/AdminLayout'
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
          <Route path="/admin/plugins/:id/*" element={<PluginDetail />} />
          <Route path="/admin/audit" element={<AuditLogPage />} />
          <Route path="/admin/recordings/:id" element={<RecordingPlayerPage />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
      <ConsoleDock />
    </Suspense>
  )
}
