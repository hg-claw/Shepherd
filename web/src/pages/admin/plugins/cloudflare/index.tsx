import { Routes, Route, Navigate } from 'react-router-dom'
import SetupTab from './SetupTab'
import ZonesTab from './ZonesTab'
import DnsTab from './DnsTab'
import HostsTab from './HostsTab'
import ActivityTab from './ActivityTab'

export default function CloudflarePlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="setup" replace />} />
      <Route path="setup" element={<SetupTab />} />
      <Route path="zones" element={<ZonesTab />} />
      <Route path="dns" element={<DnsTab />} />
      <Route path="hosts" element={<HostsTab />} />
      <Route path="activity" element={<ActivityTab />} />
    </Routes>
  )
}
