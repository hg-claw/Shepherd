import { Routes, Route, Navigate } from 'react-router-dom'
import ConfigTab from './ConfigTab'
import InboundsTab from './InboundsTab'
import CertificatesTab from './CertificatesTab'
import TrafficTab from './TrafficTab'
import EventsTab from './EventsTab'
import LogsTab from './LogsTab'

export default function SingboxPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="config" replace />} />
      <Route path="config"       element={<ConfigTab />} />
      <Route path="inbounds"     element={<InboundsTab />} />
      <Route path="certificates" element={<CertificatesTab />} />
      <Route path="traffic"      element={<TrafficTab />} />
      <Route path="events"       element={<EventsTab />} />
      <Route path="logs"         element={<LogsTab />} />
    </Routes>
  )
}
