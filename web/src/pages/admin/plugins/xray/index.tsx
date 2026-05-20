import { Routes, Route, Navigate } from 'react-router-dom'
import DeployTab from './DeployTab'
import InboundsTab from './InboundsTab'
import TrafficTab from './TrafficTab'
import EventsTab from './EventsTab'
import LogsTab from './LogsTab'

export default function XrayPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="deploy" replace />} />
      <Route path="deploy"   element={<DeployTab />} />
      <Route path="inbounds" element={<InboundsTab />} />
      <Route path="traffic"  element={<TrafficTab />} />
      <Route path="events"   element={<EventsTab />} />
      <Route path="logs"     element={<LogsTab />} />
    </Routes>
  )
}
