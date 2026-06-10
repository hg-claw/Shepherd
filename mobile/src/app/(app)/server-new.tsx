import { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, KeyboardAvoidingView, Platform } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useScriptInstall, type ScriptInstallResult } from '@/api/install'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Card, Field, Input, Label, Hint, ErrLine, Button, Switch } from '@/components/ds'

// expo-clipboard is a NATIVE module. Load it guardedly so a JS-only update on an
// older dev client (one built before this dep was added) doesn't crash the whole
// screen — copy just no-ops until the client is rebuilt.
let clipboardSet: ((s: string) => Promise<unknown>) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  clipboardSet = require('expo-clipboard').setStringAsync
} catch {
  clipboardSet = null
}

// Hermes builds without Intl lack toLocaleString, so render the raw RFC3339
// stamp plus a relative "in Xm" computed by hand.
function expiryLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms)) return `Token expires ${iso}`
  const m = Math.max(0, Math.round(ms / 60000))
  return `Token expires in ${m}m (${iso})`
}

export default function ServerNew() {
  const t = useTheme()
  const router = useRouter()
  const install = useScriptInstall()
  // Same field set the web script-install tab sends (web/src/pages/admin/ServerNew.tsx).
  const [name, setName] = useState('')
  const [publicAlias, setPublicAlias] = useState('')
  const [publicGroup, setPublicGroup] = useState('')
  const [countryCode, setCountryCode] = useState('')
  const [showOnPublic, setShowOnPublic] = useState(false)
  const [cnMirror, setCnMirror] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ScriptInstallResult | null>(null)
  const [copied, setCopied] = useState(false)
  // The "Copied" flash timer — cleared on unmount so it can't fire afterwards.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const submit = async () => {
    if (!name.trim()) { setError('name required'); return }
    setBusy(true); setError(null)
    try {
      const r = await install({
        name,
        public_alias: publicAlias || undefined,
        public_group: publicGroup || undefined,
        country_code: countryCode || undefined,
        show_on_public: showOnPublic,
        cn: cnMirror,
      })
      setResult(r)
      setCopied(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'install failed')
    } finally { setBusy(false) }
  }

  const copy = () => {
    if (!result || !clipboardSet) return
    void clipboardSet(result.command)
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Add server' }} />
      <NavBar title="Add server" backLabel="Servers" onBack={() => router.back()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, paddingBottom: 44, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          {result ? (
            <>
              <Card>
                <View style={{ padding: 14, gap: 12 }}>
                  <Text style={{ fontFamily: t.font(600), fontSize: t.fs.md, color: t.text }}>
                    Run this on the target host
                  </Text>
                  <View style={{ backgroundColor: t.sunken, borderWidth: 1, borderColor: t.border, borderRadius: t.radius, padding: 12 }}>
                    <Text selectable style={{ fontFamily: t.mono(), fontSize: 12, color: t.text }}>
                      {result.command}
                    </Text>
                  </View>
                  {clipboardSet ? (
                    <Button variant="outline" icon="copy" onPress={copy}>
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  ) : null}
                  <Hint>{expiryLabel(result.expires_at)}</Hint>
                </View>
              </Card>
              <Button variant="ghost" icon="rotate-cw" onPress={() => setResult(null)}>
                Generate another command
              </Button>
            </>
          ) : (
            <>
              <View>
                <Text style={{ fontFamily: t.mono(600), fontSize: 22, letterSpacing: -0.22, color: t.text }}>
                  Add via install script
                </Text>
                <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.muted, marginTop: 3 }}>
                  Generate a one-time install command to run on the target host.
                  The SSH-credential method is available on the web console.
                </Text>
              </View>

              <Field label="Name" required>
                <Input
                  mono
                  placeholder="name"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={name}
                  onChangeText={setName}
                />
              </Field>
              <Field label="Public alias">
                <Input
                  mono
                  placeholder="public alias"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={publicAlias}
                  onChangeText={setPublicAlias}
                />
              </Field>
              <Field label="Public group">
                <Input
                  mono
                  placeholder="public group"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={publicGroup}
                  onChangeText={setPublicGroup}
                />
              </Field>
              <Field label="Country code (ISO-2)">
                <Input
                  mono
                  placeholder="US"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={2}
                  value={countryCode}
                  onChangeText={(v) => setCountryCode(v.toUpperCase())}
                />
              </Field>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Switch on={showOnPublic} onChange={setShowOnPublic} testID="switch-public" />
                <Label>Show on public wall</Label>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Switch on={cnMirror} onChange={setCnMirror} testID="switch-cn" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label>CN mirror (gh-proxy.com — for mainland-China hosts)</Label>
                </View>
              </View>

              {error ? <ErrLine>{error}</ErrLine> : null}

              <Button variant="primary" block icon="plus" disabled={busy} onPress={() => { void submit() }}>
                {busy ? 'Issuing…' : 'Generate install command'}
              </Button>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}
