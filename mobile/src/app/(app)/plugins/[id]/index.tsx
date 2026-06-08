import { useState } from 'react'
import { View, Text, Pressable, Switch, ScrollView } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { usePlugins, enablePlugin, disablePlugin } from '@/api/plugins'
import { theme } from '@/theme'
import { Screen } from '@/components/Screen'

export default function PluginDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const q = usePlugins()
  const p = q.data?.find((x) => x.id === id)
  const [busy, setBusy] = useState(false)

  if (!p) return <Screen edges={['bottom']}><View style={{ padding: theme.space(4) }}><Text style={{ color: theme.textDim }}>Plugin not found.</Text></View></Screen>

  const toggle = async (on: boolean) => {
    setBusy(true)
    try { if (on) await enablePlugin(p.id); else await disablePlugin(p.id); await q.refetch() } finally { setBusy(false) }
  }
  const rowStyle = { padding: theme.space(3), borderTopWidth: 1, borderColor: theme.border }

  return (
    <Screen edges={['bottom']}>
    <Stack.Screen options={{ title: 'Plugin' }} />
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: theme.space(4) }}>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: '700' }}>{p.meta.icon} {p.meta.name}</Text>
        {p.meta.description ? <Text style={{ color: theme.textDim, marginTop: theme.space(2) }}>{p.meta.description}</Text> : null}
        <Text style={{ color: theme.textDim, fontSize: 12, marginTop: theme.space(2) }}>{p.meta.category}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', ...rowStyle }}>
        <Text style={{ color: theme.text, flex: 1 }}>Enabled</Text>
        <Switch testID="detail-toggle" value={p.enabled} disabled={busy} onValueChange={toggle} />
      </View>
      <Pressable onPress={() => router.push(`/(app)/plugins/${p.id}/config`)} style={rowStyle}>
        <Text style={{ color: theme.accent }}>Edit config</Text>
      </Pressable>
      {p.meta.host_aware ? (
        <Pressable onPress={() => router.push(`/(app)/plugins/${p.id}/hosts`)} style={rowStyle}>
          <Text style={{ color: theme.accent }}>Hosts{p.host_count != null ? ` (${p.host_count})` : ''}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
    </Screen>
  )
}
