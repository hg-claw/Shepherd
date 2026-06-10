import { useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { usePluginConfig, savePluginConfig } from '@/api/plugins'
import { useTheme } from '@/theme'
import { NavBar, Field, Input, Button, ErrLine, Empty } from '@/components/ds'

function Editor({ id, initial }: { id: string; initial: Record<string, unknown> }) {
  const router = useRouter()
  const t = useTheme()
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
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title="Config" onBack={() => router.back()} backLabel="Plugin" />
      {/* Keep the Save button reachable while the keyboard is up. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim }}>
            {id}.yml — secrets show as &quot;***&quot;; leave them to keep the stored value.
          </Text>
          <Field label="config">
            <Input
              testID="config-input"
              mono
              multiline
              value={text}
              onChangeText={setText}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ height: undefined, minHeight: 260, paddingVertical: 12, textAlignVertical: 'top', fontSize: 12.5 }}
            />
          </Field>
          {error ? <ErrLine>{error}</ErrLine> : null}
          <Button variant="primary" icon="play" block disabled={busy} onPress={save}>Save</Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}

export default function PluginConfig() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const t = useTheme()
  const router = useRouter()
  const q = usePluginConfig(id)
  if (q.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <NavBar title="Config" onBack={() => router.back()} backLabel="Plugin" />
        <ActivityIndicator color={t.primary} style={{ marginTop: 32 }} />
      </View>
    )
  }
  if (q.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <NavBar title="Config" onBack={() => router.back()} backLabel="Plugin" />
        <Empty>failed to load config</Empty>
      </View>
    )
  }
  return <Editor id={id} initial={q.data ?? {}} />
}
