import { Routes, Route, Navigate } from 'react-router-dom'
import SubscriptionsTab from './SubscriptionsTab'
import TemplatesTab from './TemplatesTab'

export default function SubgenPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="subscriptions" replace />} />
      <Route path="subscriptions" element={<SubscriptionsTab />} />
      <Route path="templates" element={<TemplatesTab />} />
    </Routes>
  )
}
