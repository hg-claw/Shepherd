import { useState } from 'react'
import { FlatList, View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { usePluginHosts, deployHost, undeployHost, startHost, stopHost, restartHost, refreshHost, type HostDeployment } from '@/api/plugins'
import { theme } from '@/theme'
import { Screen } from '@/components/Screen'

function Btn({ testID, label, onPress }: { testID: string; label: string; onPress: () => void }) {
  return (
    <Pressable testID={testID} onPress={onPress} style={{ paddingVertical: theme.space(1), paddingHorizontal: theme.space(2), borderWidth: 1, borderColor: theme.border, borderRadius: 6 }}>
      <Text style={{ color: theme.accent, fontSize: 12 }}>{label}</Text>
    </Pressable>
  )
}

export default function PluginHosts() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const q = usePluginHosts(id)
  const [serverId, setServerId] = useState('')
  const run = async (fn: () => Promise<unknown>) => { await fn(); await q.refetch() }

  const renderRow = (h: HostDeployment) => {
    const bad = h.status === 'failed' || h.status === 'error'
    return (
      <View style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text }}>server #{h.server_id}{h.deployed_version ? ` · ${h.deployed_version}` : ''}</Text>
        <Text style={{ color: bad ? theme.error : theme.textDim, fontFamily: 'monospace', fontSize: 12 }}>{h.status}{h.last_error ? ` — ${h.last_error}` : ''}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2), marginTop: theme.space(2) }}>
          <Btn testID={`start-${h.server_id}`} label="Start" onPress={() => run(() => startHost(id, h.server_id))} />
          <Btn testID={`stop-${h.server_id}`} label="Stop" onPress={() => run(() => stopHost(id, h.server_id))} />
          <Btn testID={`restart-${h.server_id}`} label="Restart" onPress={() => run(() => restartHost(id, h.server_id))} />
          <Btn testID={`refresh-${h.server_id}`} label="Refresh" onPress={() => run(() => refreshHost(id, h.server_id))} />
          <Btn testID={`undeploy-${h.server_id}`} label="Undeploy" onPress={() => run(() => undeployHost(id, h.server_id))} />
        </View>
      </View>
    )
  }

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(2), padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <TextInput value={serverId} onChangeText={setServerId} keyboardType="number-pad" placeholder="server id" placeholderTextColor={theme.textDim}
          style={{ flex: 1, backgroundColor: theme.surface, color: theme.text, borderColor: theme.border, borderWidth: 1, borderRadius: 8, padding: theme.space(2) }} />
        <Pressable onPress={() => { if (serverId.trim()) run(() => deployHost(id, { server_id: Number(serverId) })) }} style={{ backgroundColor: theme.accent, paddingVertical: theme.space(2), paddingHorizontal: theme.space(3), borderRadius: 8 }}>
          <Text style={{ color: theme.bg, fontWeight: '600' }}>Deploy</Text>
        </Pressable>
      </View>
      {q.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : q.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>failed to load hosts</Text>
        : <FlatList data={q.data ?? []} keyExtractor={(h) => String(h.id)} renderItem={({ item }) => renderRow(item)}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>Not deployed anywhere.</Text>} />}
    </Screen>
  )
}
