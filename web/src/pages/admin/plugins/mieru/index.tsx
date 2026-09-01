import { Routes, Route, Navigate } from 'react-router-dom'
import DeployTab from './DeployTab'
import InboundsTab from './InboundsTab'
import LogsTab from './LogsTab'

export default function MieruPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="deploy" replace />} />
      <Route path="deploy" element={<DeployTab />} />
      <Route path="inbounds" element={<InboundsTab />} />
      <Route path="logs" element={<LogsTab />} />
    </Routes>
  )
}
