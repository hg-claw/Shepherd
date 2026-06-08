import { View, Text, ActivityIndicator, ScrollView } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useRun } from '@/api/scripts'
import { theme } from '@/theme'
import { Screen } from '@/components/Screen'

export default function RunStatus() {
  const { runId } = useLocalSearchParams<{ runId: string }>()
  const q = useRun(Number(runId))
  const rows = q.data ?? []
  return (
    <Screen edges={['top']}>
      <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space(4) }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600', marginBottom: theme.space(3) }}>Run #{runId}</Text>
        {q.isLoading ? <ActivityIndicator color={theme.accent} /> : null}
        {rows.map((t) => (
          <View key={t.id} style={{ paddingVertical: theme.space(2), borderBottomWidth: 1, borderColor: theme.border }}>
            <Text style={{ color: theme.text }}>server #{t.server_id}</Text>
            <Text style={{ color: t.status === 'failed' || t.status === 'error' ? theme.error : theme.textDim, fontFamily: 'monospace' }}>
              {t.status}{t.exit_code != null ? ` (exit ${t.exit_code})` : ''}
            </Text>
          </View>
        ))}
        {!q.isLoading && rows.length === 0 ? <Text style={{ color: theme.textDim }}>queued…</Text> : null}
      </ScrollView>
    </Screen>
  )
}
