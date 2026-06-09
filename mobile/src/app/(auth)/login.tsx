import { useState } from 'react'
import { View, Text } from 'react-native'
import { useAuth } from '@/store/auth'
import { useTheme } from '@/theme'
import { BrandMark, Field, Input, Button, ErrLine } from '@/components/ds'

export default function LoginScreen() {
  const t = useTheme()
  const login = useAuth((s) => s.login)
  const error = useAuth((s) => s.error)
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    await login(url, user, pass)
    setBusy(false)
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 40, gap: 14 }}>
        <View style={{ marginBottom: 14, alignItems: 'center' }}>
          <BrandMark />
        </View>
        <Text style={{ textAlign: 'center', fontSize: 12.5, color: t.muted, marginBottom: 8 }}>
          Self-hosted server fleet manager
        </Text>

        <Field label="Server">
          <Input
            mono
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://your-server"
          />
        </Field>
        <Field label="Username">
          <Input
            value={user}
            onChangeText={setUser}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="admin"
          />
        </Field>
        <Field label="Password">
          <Input
            value={pass}
            onChangeText={setPass}
            secureTextEntry
            placeholder="password"
          />
        </Field>

        {error ? <ErrLine>{error}</ErrLine> : null}

        <View style={{ marginTop: 6 }}>
          <Button block disabled={busy} onPress={() => { void submit() }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </View>

        <Text style={{ textAlign: 'center', fontFamily: t.mono(), fontSize: 11, color: t.fgDim, marginTop: 4 }}>
          token stored in secure enclave · v1.0.0
        </Text>
      </View>
    </View>
  )
}
