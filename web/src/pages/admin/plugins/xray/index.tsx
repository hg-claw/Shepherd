import { Routes, Route, Navigate } from 'react-router-dom'
import ConfigTab from './ConfigTab'
import HostsTab from './HostsTab'

export default function XrayPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="config" replace />} />
      <Route path="config" element={<ConfigTab />} />
      <Route path="hosts" element={<HostsTab />} />
      {/* events + logs in Task 27 */}
    </Routes>
  )
}
