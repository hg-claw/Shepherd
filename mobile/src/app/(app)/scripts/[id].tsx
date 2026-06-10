import { useState } from 'react'
import { View, Text, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useScripts, runScript } from '@/api/scripts'
import { useServers, type ServerRow } from '@/api/servers'
import { isOnline, nullStr } from '@/api/metrics'
import { cmpStr } from '@/lib/format'
import { useTheme } from '@/theme'
import { NavBar, Pill, Field, Input, Button, ErrLine, Hint, Empty, OnlineDot, List } from '@/components/ds'

const aliasOf = (r: ServerRow) => nullStr(r.public_alias) || r.name || `#${r.id}`

function CheckBox({ checked }: { checked: boolean }) {
  const t = useTheme()
  return (
    <View
      style={{
        width: 18, height: 18, borderRadius: 5, alignItems: 'center', justifyContent: 'center',
        borderWidth: 1.5, borderColor: checked ? t.primary : t.borderStrong,
        backgroundColor: checked ? t.primary : 'transparent',
      }}
    >
      {checked ? <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: t.primaryFg }} /> : null}
    </View>
  )
}

function TargetRow({ server, selected, onToggle }: { server: ServerRow; selected: boolean; onToggle: () => void }) {
  const t = useTheme()
  const online = isOnline(server)
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12,
        minHeight: 48, paddingVertical: 10, paddingHorizontal: 14,
        backgroundColor: pressed ? t.sunken : 'transparent',
      })}
    >
      <OnlineDot online={online} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: t.mono(500), fontSize: t.fs.md, color: t.text }}>
          {aliasOf(server)}
        </Text>
        <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: 11, color: t.fgDim, marginTop: 1 }}>
          {`#${server.id}${online ? '' : ' · offline'}`}
        </Text>
      </View>
      <CheckBox checked={selected} />
    </Pressable>
  )
}

export default function RunForm() {
  const { id, serverId } = useLocalSearchParams<{ id: string; serverId?: string }>()
  const router = useRouter()
  const t = useTheme()
  const script = useScripts().data?.find((s) => s.id === Number(id))
  const servers = useServers().data ?? []
  // Store only user edits; the effective value falls back to each param's default. This way defaults
  // appear reactively once useScripts resolves after mount (a one-shot useState initializer would miss them).
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  // Same derivation pattern for target selection: the ?serverId= route param (when
  // it parses to a real number — it can be absent or the literal string "undefined")
  // provides the default; explicit user toggles override it.
  const preId = Number(serverId)
  const preValid = Number.isFinite(preId)
  const [selOverrides, setSelOverrides] = useState<Record<number, boolean>>({})
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

  const isSelected = (sid: number) => selOverrides[sid] ?? (preValid && sid === preId)
  const sorted = [...servers].sort((a, b) => {
    const oa = isOnline(a) ? 0 : 1, ob = isOnline(b) ? 0 : 1
    return oa - ob || cmpStr(aliasOf(a), aliasOf(b))
  })
  const selectedIds = sorted.filter((s) => isSelected(s.id)).map((s) => s.id)
  const onlineCount = sorted.filter(isOnline).length
  const selectAllOnline = () => {
    setSelOverrides((prev) => {
      const next = { ...prev }
      for (const s of sorted) if (isOnline(s)) next[s.id] = true
      return next
    })
  }

  const run = async () => {
    if (missing.length) { setError(`Required: ${missing.map((p) => p.label ?? p.name).join(', ')}`); return }
    setBusy(true); setError(null)
    try {
      const args = Object.fromEntries(script.params.map((p) => [p.name, valueFor(p.name, p.default)]))
      const { run_id } = await runScript(script.id, args, selectedIds)
      router.push(`/(app)/scripts/run/${run_id}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'run failed') } finally { setBusy(false) }
  }

  const n = selectedIds.length
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title="Run script" backLabel="Scripts" onBack={() => router.back()} />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, paddingBottom: 44, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <View>
            <Text style={{ fontFamily: t.mono(600), fontSize: 22, letterSpacing: -0.22, color: t.text }}>{script.name}</Text>
            {script.description ? (
              <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.muted, marginTop: 3 }}>{script.description}</Text>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <Pill kind="neutral">{`⌖ ${n} target${n === 1 ? '' : 's'}`}</Pill>
              <Pill kind="neutral">{`${script.params.length} params`}</Pill>
            </View>
          </View>

          <Field label="Targets">
            {sorted.length === 0 ? (
              <Hint>no servers</Hint>
            ) : (
              <List>
                {sorted.map((s) => (
                  <TargetRow
                    key={s.id}
                    server={s}
                    selected={isSelected(s.id)}
                    onToggle={() => setSelOverrides((prev) => ({ ...prev, [s.id]: !(prev[s.id] ?? (preValid && s.id === preId)) }))}
                  />
                ))}
              </List>
            )}
            {onlineCount > 0 ? (
              <Button variant="ghost" icon="target" onPress={selectAllOnline}>
                {`Select all online (${onlineCount})`}
              </Button>
            ) : null}
          </Field>

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

          <Button variant="primary" block icon="play" disabled={busy || n === 0} onPress={run}>
            {n === 0 ? 'Run' : `Run on ${n} server${n === 1 ? '' : 's'}`}
          </Button>
          {n === 0 ? <Hint>select at least one target server</Hint> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}
