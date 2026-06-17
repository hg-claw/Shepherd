import { useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { usePlugins, enablePlugin, disablePlugin } from '@/api/plugins'
import { useTheme } from '@/theme'
import { NavBar, List, ListRow, Switch, Pill, Icon, Empty } from '@/components/ds'

// Plugins with a read-only traffic/cert status view on mobile (see ./status.tsx).
const STATUS_VIEW_IDS = new Set(['singbox', 'xray'])
// Proxy plugins that get the inbounds management screen (./inbounds.tsx).
const INBOUNDS_IDS = new Set(['singbox', 'xray'])

export default function PluginDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const t = useTheme()
  const q = usePlugins()
  const p = q.data?.find((x) => x.id === id)
  const [busy, setBusy] = useState(false)

  // While the plugins query loads, show a spinner — otherwise "not found"
  // flashes before the data arrives.
  if (q.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <NavBar title="Plugin" onBack={() => router.back()} backLabel="Plugins" />
        <ActivityIndicator testID="plugin-loading" color={t.primary} style={{ marginTop: 32 }} />
      </View>
    )
  }

  if (!p) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <NavBar title="Plugin" onBack={() => router.back()} backLabel="Plugins" />
        <Empty>Plugin not found.</Empty>
      </View>
    )
  }

  const toggle = async (on: boolean) => {
    setBusy(true)
    try { if (on) await enablePlugin(p.id); else await disablePlugin(p.id); await q.refetch() } finally { setBusy(false) }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title={p.meta.name} onBack={() => router.back()} backLabel="Plugins" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: t.sunken }}>
            <Icon name={p.meta.icon || 'puzzle'} size={24} color={t.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontFamily: t.font(600), fontSize: 22, letterSpacing: -0.22, color: t.text }}>{p.meta.name}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <Pill kind={p.enabled ? 'ok' : 'neutral'}>{p.enabled ? 'enabled' : 'disabled'}</Pill>
              <Pill kind="neutral">{p.meta.category}</Pill>
            </View>
          </View>
        </View>

        {p.meta.description ? (
          <Text style={{ fontFamily: t.font(), fontSize: 13.5, lineHeight: 20, color: t.muted }}>{p.meta.description}</Text>
        ) : null}

        <List>
          <ListRow
            title="Enabled"
            chevron={false}
            right={<Switch testID="detail-toggle" on={p.enabled} disabled={busy} onChange={toggle} />}
          />
          {p.id === 'cloudflare' ? (
            <ListRow
              icon="cloud"
              title="Cloudflare"
              onPress={() => router.push(`/(app)/plugin/${p.id}/cloudflare`)}
            />
          ) : null}
          {p.id === 'netquality' ? (
            <ListRow
              icon="gauge"
              title="Network Quality"
              onPress={() => router.push(`/(app)/plugin/${p.id}/netquality`)}
            />
          ) : null}
          {INBOUNDS_IDS.has(p.id) ? (
            <ListRow
              icon="network"
              title="Inbounds"
              onPress={() => router.push(`/(app)/plugin/${p.id}/inbounds`)}
            />
          ) : null}
          {p.id === 'subgen' ? (
            <ListRow
              icon="rss"
              title="Subscriptions"
              onPress={() => router.push(`/(app)/plugin/${p.id}/subgen`)}
            />
          ) : null}
          {p.id === 'sshaudit' ? (
            <ListRow
              icon="shield"
              title="SSH Audit"
              onPress={() => router.push(`/(app)/plugin/${p.id}/sshaudit`)}
            />
          ) : null}
          <ListRow
            icon="settings"
            title="Edit config"
            onPress={() => router.push(`/(app)/plugin/${p.id}/config`)}
          />
          {p.meta.host_aware ? (
            <ListRow
              icon="server"
              title="Hosts"
              detail={p.host_count != null ? String(p.host_count) : ''}
              onPress={() => router.push(`/(app)/plugin/${p.id}/hosts`)}
            />
          ) : null}
          {p.meta.host_aware ? (
            <ListRow
              icon="scroll-text"
              title="Logs"
              onPress={() => router.push(`/(app)/plugin/${p.id}/logs`)}
            />
          ) : null}
          {STATUS_VIEW_IDS.has(p.id) ? (
            <ListRow
              icon="activity"
              title="Status"
              onPress={() => router.push(`/(app)/plugin/${p.id}/status`)}
            />
          ) : null}
        </List>

        <Text style={{ textAlign: 'center', fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>plugin id · {p.id}</Text>
      </ScrollView>
    </View>
  )
}
