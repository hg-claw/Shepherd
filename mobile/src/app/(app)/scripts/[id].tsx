import { useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useScripts, runScript } from '@/api/scripts'
import { theme } from '@/theme'
import { Screen } from '@/components/Screen'

export default function RunForm() {
  const { id, serverId } = useLocalSearchParams<{ id: string; serverId: string }>()
  const router = useRouter()
  const script = useScripts().data?.find((s) => s.id === Number(id))
  // Store only user edits; the effective value falls back to each param's default. This way defaults
  // appear reactively once useScripts resolves after mount (a one-shot useState initializer would miss them).
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!script) return <Screen edges={['bottom']}><View style={{ padding: theme.space(4) }}><Text style={{ color: theme.textDim }}>Script not found.</Text></View></Screen>

  const valueFor = (name: string, def?: string) => overrides[name] ?? def ?? ''
  const missing = script.params.filter((p) => p.required && !valueFor(p.name, p.default).trim())
  const run = async () => {
    if (missing.length) { setError(`Required: ${missing.map((p) => p.label ?? p.name).join(', ')}`); return }
    setBusy(true); setError(null)
    try {
      const args = Object.fromEntries(script.params.map((p) => [p.name, valueFor(p.name, p.default)]))
      const { run_id } = await runScript(script.id, args, Number(serverId))
      router.push(`/(app)/scripts/run/${run_id}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'run failed') } finally { setBusy(false) }
  }

  return (
    <Screen edges={['bottom']}>
    <Stack.Screen options={{ title: 'Run script' }} />
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space(4) }}>
      <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600', marginBottom: theme.space(3) }}>{script.name}</Text>
      {script.params.map((p) => (
        <View key={p.name} style={{ marginBottom: theme.space(3) }}>
          <Text style={{ color: theme.textDim, marginBottom: theme.space(1) }}>{p.label ?? p.name}{p.required ? ' *' : ''}</Text>
          <TextInput placeholder={p.name} placeholderTextColor={theme.textDim} autoCapitalize="none" autoCorrect={false}
            value={valueFor(p.name, p.default)} onChangeText={(t) => setOverrides((a) => ({ ...a, [p.name]: t }))}
            style={{ backgroundColor: theme.surface, color: theme.text, borderColor: theme.border, borderWidth: 1, borderRadius: 8, padding: theme.space(3) }} />
        </View>
      ))}
      {error ? <Text style={{ color: theme.error, marginBottom: theme.space(2) }}>{error}</Text> : null}
      <Pressable onPress={run} disabled={busy} style={{ backgroundColor: theme.accent, padding: theme.space(3), borderRadius: 8, alignItems: 'center', opacity: busy ? 0.6 : 1 }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Run</Text>
      </Pressable>
    </ScrollView>
    </Screen>
  )
}
