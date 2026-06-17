import { Routes, Route, Navigate } from 'react-router-dom'
import HostsTab from './HostsTab'
import SessionsTab from './SessionsTab'
import HistoryTab from './HistoryTab'

export default function SSHAuditPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="hosts" replace />} />
      <Route path="hosts" element={<HostsTab />} />
      <Route path="sessions" element={<SessionsTab />} />
      <Route path="history" element={<HistoryTab />} />
    </Routes>
  )
}
