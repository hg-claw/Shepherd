import { useState } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { usePlugins, enablePlugin, disablePlugin, type Plugin } from '@/api/plugins'
import { useSshauditOverview } from '@/api/sshaudit'
import { cmpStr } from '@/lib/format'
import { Header, List, ListRow, Switch, Empty } from '@/components/ds'
import { useTheme } from '@/theme'

// Compact fleet-wide 24h SSH login tally — only rendered on the enabled
// sshaudit row. Counts via String(n) (Hermes has no toLocaleString).
function SshauditBadge() {
  const t = useTheme()
  const q = useSshauditOverview(true)
  const d = q.data
  if (!d) return null
  return (
    <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: 11.5, marginTop: 1 }}>
      <Text style={{ color: t.muted }}>24h </Text>
      <Text style={{ color: t.ok }}>{`✓${String(d.accepted)}`}</Text>
      <Text style={{ color: t.muted }}>{' '}</Text>
      <Text style={{ color: t.err }}>{`✗${String(d.failed)}`}</Text>
    </Text>
  )
}

function PluginRow({ p, onToggle, onOpen }: { p: Plugin; onToggle: (on: boolean) => Promise<void>; onOpen: () => void }) {
  const t = useTheme()
  const [busy, setBusy] = useState(false)
  const toggle = async (on: boolean) => { setBusy(true); try { await onToggle(on) } finally { setBusy(false) } }
  const sub = p.meta.host_aware && p.enabled && p.host_count ? `${p.host_count} hosts` : p.meta.category.toLowerCase()
  const showSshauditBadge = p.id === 'sshaudit' && p.enabled
  return (
    <ListRow
      icon={p.meta.icon || 'puzzle'}
      iconColor={t.primary}
      title={
        <View>
          <Text numberOfLines={1} style={{ fontFamily: t.font(500), fontSize: t.fs.md, color: t.text }}>{p.meta.name}</Text>
          <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.muted, marginTop: 1 }}>{sub}</Text>
          {showSshauditBadge ? <SshauditBadge /> : null}
        </View>
      }
      chevron={false}
      onPress={onOpen}
      right={<Switch testID={`toggle-${p.id}`} on={p.enabled} disabled={busy} onChange={toggle} />}
    />
  )
}

export default function PluginsList() {
  const t = useTheme()
  const router = useRouter()
  const q = usePlugins()
  const plugins = q.data ?? []
  const enabledCount = plugins.filter((p) => p.enabled).length

  const onToggle = async (p: Plugin, on: boolean) => {
    if (on) await enablePlugin(p.id)
    else await disablePlugin(p.id)
    await q.refetch()
  }

  const cats = new Map<string, Plugin[]>()
  for (const p of plugins) {
    const a = cats.get(p.meta.category) ?? []
    a.push(p)
    cats.set(p.meta.category, a)
  }
  const ordered = [...cats.entries()].sort(([a], [b]) => cmpStr(a, b))

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header title="Plugins" sub={`${enabledCount} of ${plugins.length} enabled`} />
      {q.isLoading ? (
        <ActivityIndicator color={t.primary} style={{ marginTop: 32 }} />
      ) : q.isError ? (
        <Text style={{ color: t.error, padding: 16 }}>failed to load plugins</Text>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 92, gap: 16 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={t.primary} />}
        >
          {ordered.length === 0 ? <Empty>No plugins.</Empty> : null}
          {ordered.map(([cat, ps]) => (
            <View key={cat} style={{ gap: 8 }}>
              <Text style={{ fontFamily: t.mono(600), fontSize: 12.5, color: t.text, paddingHorizontal: 2 }}>{cat}</Text>
              <List>
                {ps.map((p) => (
                  <PluginRow
                    key={p.id}
                    p={p}
                    onToggle={(on) => onToggle(p, on)}
                    onOpen={() => router.push(`/(app)/plugin/${p.id}`)}
                  />
                ))}
              </List>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  )
}
