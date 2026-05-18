import { Routes, Route, Navigate } from 'react-router-dom'
import ConfigTab from './ConfigTab'
import HostsTab from './HostsTab'
import EventsTab from './EventsTab'
import LogsTab from './LogsTab'

export default function XrayPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="config" replace />} />
      <Route path="config" element={<ConfigTab />} />
      <Route path="hosts" element={<HostsTab />} />
      <Route path="events" element={<EventsTab />} />
      <Route path="logs" element={<LogsTab />} />
    </Routes>
  )
}
