import { useState } from 'react'
import { Text, ScrollView, KeyboardAvoidingView, Platform } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { createNetqualityTarget, type NetqualityISP } from '@/api/netquality'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Field, Input, Segmented, Button, ErrLine } from '@/components/ds'

// ISP options carry the validated server-side codes with their Chinese labels.
const ISP_OPTIONS: { value: NetqualityISP; label: string }[] = [
  { value: 'telecom', label: '电信' },
  { value: 'unicom', label: '联通' },
  { value: 'mobile', label: '移动' },
  { value: 'overseas', label: '海外' },
]

export default function NetqualityTargetNewScreen() {
  const router = useRouter()
  const t = useTheme()
  const [isp, setISP] = useState<NetqualityISP>('telecom')
  const [region, setRegion] = useState('')
  const [label, setLabel] = useState('')
  const [host, setHost] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = label.trim().length > 0 && host.trim().length > 0 && !busy

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true); setError(null)
    try {
      await createNetqualityTarget({
        isp,
        // region is optional server-side (empty → 'Custom'); only send when set.
        region: region.trim() || undefined,
        label: label.trim(),
        host: host.trim(),
      })
      router.back()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'New target' }} />
      <NavBar title="New target" onBack={() => router.back()} backLabel="Network quality" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <Field label="ISP">
            <Segmented<NetqualityISP> value={isp} onChange={setISP} options={ISP_OPTIONS} />
          </Field>
          <Field label="region">
            <Input
              testID="region-input"
              value={region}
              onChangeText={setRegion}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Custom"
            />
            <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim }}>
              Optional — defaults to &quot;Custom&quot;.
            </Text>
          </Field>
          <Field label="label" required>
            <Input
              testID="label-input"
              value={label}
              onChangeText={setLabel}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="电信上海"
            />
          </Field>
          <Field label="host" required>
            <Input
              testID="host-input"
              mono
              value={host}
              onChangeText={setHost}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="1.2.3.4 or example.com"
            />
          </Field>
          {error ? <ErrLine>{error}</ErrLine> : null}
          <Button testID="target-submit" variant="primary" icon="plus" block disabled={!canSubmit} onPress={submit}>
            Add target
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}
