import { useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { usePluginConfig, savePluginConfig } from '@/api/plugins'
import { theme } from '@/theme'

function Editor({ id, initial }: { id: string; initial: Record<string, unknown> }) {
  const router = useRouter()
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(text) } catch { setError('Invalid JSON'); return }
    setBusy(true); setError(null)
    try { await savePluginConfig(id, parsed); router.back() }
    catch (e) { setError(e instanceof Error ? e.message : 'save failed') }
    finally { setBusy(false) }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space(4) }}>
      <Text style={{ color: theme.textDim, fontSize: 12, marginBottom: theme.space(2) }}>Secrets show as &quot;***&quot; — leave them to keep the stored value.</Text>
      <TextInput testID="config-input" multiline value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false}
        style={{ backgroundColor: theme.surface, color: theme.text, fontFamily: 'monospace', fontSize: 12, borderColor: theme.border, borderWidth: 1, borderRadius: 8, padding: theme.space(3), minHeight: 240, textAlignVertical: 'top' }} />
      {error ? <Text style={{ color: theme.error, marginTop: theme.space(2) }}>{error}</Text> : null}
      <Pressable onPress={save} disabled={busy} style={{ backgroundColor: theme.accent, padding: theme.space(3), borderRadius: 8, alignItems: 'center', marginTop: theme.space(3), opacity: busy ? 0.6 : 1 }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Save</Text>
      </Pressable>
    </ScrollView>
  )
}

export default function PluginConfig() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const q = usePluginConfig(id)
  if (q.isLoading) return <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center' }}><ActivityIndicator color={theme.accent} /></View>
  if (q.isError) return <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(4) }}><Text style={{ color: theme.error }}>failed to load config</Text></View>
  return <Editor id={id} initial={q.data ?? {}} />
}
