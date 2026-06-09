import { useState } from 'react'
import { FlatList, View, Text, Pressable, Switch, ActivityIndicator } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { usePlugins, enablePlugin, disablePlugin, type Plugin } from '@/api/plugins'
import { theme } from '@/theme'
import { Screen } from '@/components/Screen'

function PluginRow({ p, onToggle, onOpen }: { p: Plugin; onToggle: (on: boolean) => Promise<void>; onOpen: () => void }) {
  const [busy, setBusy] = useState(false)
  const toggle = async (on: boolean) => { setBusy(true); try { await onToggle(on) } finally { setBusy(false) } }
  return (
    <Pressable onPress={onOpen} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(3), padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
      <Text style={{ fontSize: 20 }}>{p.meta.icon || '🔌'}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.text, fontWeight: '600' }}>{p.meta.name}</Text>
        <Text style={{ color: theme.textDim, fontSize: 12 }}>{p.meta.category}</Text>
      </View>
      <Switch testID={`toggle-${p.id}`} value={p.enabled} disabled={busy} onValueChange={toggle} />
    </Pressable>
  )
}

export default function PluginsList() {
  const router = useRouter()
  const q = usePlugins()
  const onToggle = async (p: Plugin, on: boolean) => {
    if (on) await enablePlugin(p.id)
    else await disablePlugin(p.id)
    await q.refetch()
  }
  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Plugins' }} />
      {q.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : q.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>failed to load plugins</Text>
        : <FlatList
            data={q.data ?? []}
            keyExtractor={(p) => p.id}
            renderItem={({ item }) => <PluginRow p={item} onToggle={(on) => onToggle(item, on)} onOpen={() => router.push(`/(app)/plugin/${item.id}`)} />}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>No plugins.</Text>}
          />}
    </Screen>
  )
}
