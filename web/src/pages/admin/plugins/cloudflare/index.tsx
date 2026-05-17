import { Routes, Route, Navigate } from 'react-router-dom'
import SetupTab from './SetupTab'
import ZonesTab from './ZonesTab'

export default function CloudflarePlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="setup" replace />} />
      <Route path="setup" element={<SetupTab />} />
      <Route path="zones" element={<ZonesTab />} />
      {/* dns + activity in Task 29 */}
    </Routes>
  )
}
