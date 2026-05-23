import { Routes, Route, Navigate } from 'react-router-dom'
import TargetsTab from './TargetsTab'
import HostsTab from './HostsTab'
import ResultsTab from './ResultsTab'

export default function NetqualityPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="hosts" replace />} />
      <Route path="hosts" element={<HostsTab />} />
      <Route path="targets" element={<TargetsTab />} />
      <Route path="results" element={<ResultsTab />} />
    </Routes>
  )
}
