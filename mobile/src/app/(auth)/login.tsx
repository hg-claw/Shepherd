import { useRef, useState } from 'react'
import { View, Text, TextInput, KeyboardAvoidingView, ScrollView, Platform, type TextInputProps } from 'react-native'
import { useAuth } from '@/store/auth'
import { useTheme } from '@/theme'
import { BrandMark, Field, Input, Button, ErrLine } from '@/components/ds'

// React 19 forwards `ref` as a regular prop, and the ds Input spreads its props
// onto the underlying TextInput — RN's public TextInputProps type just doesn't
// declare `ref`, so widen the component type once for focus chaining.
const RefInput = Input as React.ComponentType<TextInputProps & { mono?: boolean; ref?: React.Ref<TextInput> }>

export default function LoginScreen() {
  const t = useTheme()
  const login = useAuth((s) => s.login)
  const error = useAuth((s) => s.error)
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const userRef = useRef<TextInput>(null)
  const passRef = useRef<TextInput>(null)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    await login(url, user, pass)
    setBusy(false)
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 40, gap: 14 }}
        keyboardShouldPersistTaps="handled"
      >
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
            keyboardType="url"
            textContentType="URL"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => userRef.current?.focus()}
            placeholder="https://your-server"
          />
        </Field>
        <Field label="Username">
          <RefInput
            ref={userRef}
            value={user}
            onChangeText={setUser}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="username"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passRef.current?.focus()}
            placeholder="admin"
          />
        </Field>
        <Field label="Password">
          <RefInput
            ref={passRef}
            value={pass}
            onChangeText={setPass}
            secureTextEntry
            autoCapitalize="none"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => { void submit() }}
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
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
