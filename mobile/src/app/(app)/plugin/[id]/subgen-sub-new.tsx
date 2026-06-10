import { useState } from 'react'
import { View, Text, ScrollView, KeyboardAvoidingView, Platform, Pressable, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { useTemplates, createSubscription, type Template } from '@/api/subgen'
import { cmpStr } from '@/lib/format'
import { useTheme } from '@/theme'
import { NavBar, Field, Input, Button, ErrLine, Hint, Empty, Pill, List } from '@/components/ds'

function CheckDot({ checked }: { checked: boolean }) {
  const t = useTheme()
  return (
    <View
      style={{
        width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
        borderWidth: 1.5, borderColor: checked ? t.primary : t.borderStrong,
        backgroundColor: checked ? t.primary : 'transparent',
      }}
    >
      {checked ? <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.primaryFg }} /> : null}
    </View>
  )
}

function TemplatePick({ tpl, selected, onPick }: { tpl: Template; selected: boolean; onPick: () => void }) {
  const t = useTheme()
  return (
    <Pressable
      testID={`tpl-pick-${tpl.id}`}
      onPress={onPick}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12,
        minHeight: 48, paddingVertical: 10, paddingHorizontal: 14,
        backgroundColor: pressed ? t.sunken : 'transparent',
      })}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: t.font(500), fontSize: t.fs.md, color: t.text }}>
          {tpl.name}
        </Text>
      </View>
      <Pill kind={tpl.builtin ? 'neutral' : 'ok'}>{tpl.builtin ? 'built-in' : 'custom'}</Pill>
      <CheckDot checked={selected} />
    </Pressable>
  )
}

export default function SubgenSubNew() {
  const router = useRouter()
  const t = useTheme()
  const qc = useQueryClient()
  const tplQ = useTemplates()
  const templates = [...(tplQ.data ?? [])].sort((a, b) => cmpStr(a.name, b.name))

  const [name, setName] = useState('')
  // Explicit pick wins; otherwise the first template (derived from the query, no
  // setState-in-effect).
  const [picked, setPicked] = useState<number | null>(null)
  const templateID = picked ?? templates[0]?.id ?? null
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!name.trim()) { setError('Name is required.'); return }
    if (templateID == null) { setError('Pick a template.'); return }
    setBusy(true); setError(null)
    try {
      await createSubscription({ name: name.trim(), template_id: templateID })
      void qc.invalidateQueries({ queryKey: ['subgen-subscriptions'] })
      router.back()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed')
    } finally { setBusy(false) }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title="New subscription" onBack={() => router.back()} backLabel="Subscriptions" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <Field label="Name" required>
            <Input
              testID="sub-name"
              placeholder="e.g. phone"
              autoCapitalize="none"
              autoCorrect={false}
              value={name}
              onChangeText={setName}
            />
          </Field>

          <Field label="Template" required>
            {tplQ.isLoading ? (
              <ActivityIndicator testID="tpl-loading" color={t.primary} style={{ alignSelf: 'flex-start' }} />
            ) : tplQ.isError ? (
              <ErrLine>failed to load templates</ErrLine>
            ) : templates.length === 0 ? (
              <Empty>No templates available.</Empty>
            ) : (
              <List>
                {templates.map((tpl) => (
                  <TemplatePick
                    key={String(tpl.id)}
                    tpl={tpl}
                    selected={tpl.id === templateID}
                    onPick={() => setPicked(tpl.id)}
                  />
                ))}
              </List>
            )}
            <Hint>The server mints the public token after you create the subscription.</Hint>
          </Field>

          {error ? <ErrLine>{error}</ErrLine> : null}

          <Button
            testID="sub-create"
            variant="primary"
            icon="plus"
            block
            disabled={busy || templateID == null || !name.trim()}
            onPress={submit}
          >
            Create subscription
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}
