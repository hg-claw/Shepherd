import { useState } from 'react'
import { View, Text, ScrollView } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useScripts, runScript } from '@/api/scripts'
import { useTheme } from '@/theme'
import { NavBar, Pill, Field, Input, Button, ErrLine, Empty } from '@/components/ds'

export default function RunForm() {
  const { id, serverId } = useLocalSearchParams<{ id: string; serverId: string }>()
  const router = useRouter()
  const t = useTheme()
  const script = useScripts().data?.find((s) => s.id === Number(id))
  // Store only user edits; the effective value falls back to each param's default. This way defaults
  // appear reactively once useScripts resolves after mount (a one-shot useState initializer would miss them).
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!script) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <NavBar title="Run script" backLabel="Scripts" onBack={() => router.back()} />
        <Empty>Script not found.</Empty>
      </View>
    )
  }

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
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title="Run script" backLabel="Scripts" onBack={() => router.back()} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 44, gap: 16 }}>
        <View>
          <Text style={{ fontFamily: t.mono(600), fontSize: 22, letterSpacing: -0.22, color: t.text }}>{script.name}</Text>
          {script.description ? (
            <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.muted, marginTop: 3 }}>{script.description}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <Pill kind="neutral">{`⌖ ${serverId || 'fan-out'}`}</Pill>
            <Pill kind="neutral">{`${script.params.length} params`}</Pill>
          </View>
        </View>

        <View style={{ gap: 16 }}>
          {script.params.map((p) => (
            <Field key={p.name} label={p.label ?? p.name} required={p.required}>
              <Input
                mono
                placeholder={p.name}
                autoCapitalize="none"
                autoCorrect={false}
                value={valueFor(p.name, p.default)}
                onChangeText={(t2) => setOverrides((a) => ({ ...a, [p.name]: t2 }))}
              />
            </Field>
          ))}
        </View>

        {error ? <ErrLine>{error}</ErrLine> : null}

        <Button variant="primary" block icon="play" disabled={busy} onPress={run}>
          {`Run on ${serverId || 'fleet'}`}
        </Button>
      </ScrollView>
    </View>
  )
}
