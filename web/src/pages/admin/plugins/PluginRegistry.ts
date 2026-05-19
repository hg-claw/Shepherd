import { lazy, type ComponentType } from 'react'

export interface PluginModule {
  default: ComponentType  // page component to render under /admin/plugins/<id>/*
}

export interface PluginUIEntry {
  module: () => Promise<PluginModule>
  tabs: { key: string; label: string }[]
}

// Map from plugin ID to its frontend module. Keys MUST match server-side
// Meta.ID. Tabs are advisory (the plugin module's default export controls
// what actually renders) — used by the detail wrapper to render the tab bar.
export const PluginRegistry: Record<string, PluginUIEntry> = {
  xray: {
    module: () => import('./xray'),
    tabs: [
      { key: 'config',   label: 'Config' },
      { key: 'inbounds', label: 'Inbounds' },
      { key: 'events',   label: 'Events' },
      { key: 'logs',   label: 'Logs' },
    ],
  },
  cloudflare: {
    module: () => import('./cloudflare'),
    tabs: [
      { key: 'setup',    label: 'Setup' },
      { key: 'zones',    label: 'Zones' },
      { key: 'dns',      label: 'DNS records' },
      { key: 'hosts',    label: 'Hosts' },
      { key: 'activity', label: 'Activity' },
    ],
  },
}

export const lazyPluginPage = (id: string) => {
  const e = PluginRegistry[id]
  if (!e) return null
  return lazy(e.module)
}
