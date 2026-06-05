import { FlatList, View, Text, Pressable, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useScripts } from '@/api/scripts'
import { theme } from '@/theme'

export default function ScriptsList() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>()
  const router = useRouter()
  const q = useScripts()
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>Run a script</Text>
        <Text style={{ color: theme.textDim, fontSize: 12 }}>on server #{serverId}</Text>
      </View>
      {q.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : q.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>failed to load scripts</Text>
        : <FlatList
            data={q.data ?? []}
            keyExtractor={(s) => String(s.id)}
            renderItem={({ item }) => (
              <Pressable onPress={() => router.push(`/(app)/scripts/${item.id}?serverId=${serverId}`)} style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>{item.name}</Text>
                {item.description ? <Text style={{ color: theme.textDim, fontSize: 12 }}>{item.description}</Text> : null}
              </Pressable>
            )}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>No scripts.</Text>}
          />}
    </View>
  )
}
