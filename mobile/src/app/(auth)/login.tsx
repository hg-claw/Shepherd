import { useState } from 'react'
import { View, Text, TextInput, Pressable } from 'react-native'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

export default function LoginScreen() {
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
  const input = { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border, borderWidth: 1, borderRadius: 8, padding: theme.space(3), marginBottom: theme.space(2) }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(5), justifyContent: 'center' }}>
      <Text style={{ color: theme.text, fontSize: 22, marginBottom: theme.space(4) }}>Shepherd</Text>
      <TextInput style={input} placeholder="https://your-server" placeholderTextColor={theme.textDim} autoCapitalize="none" autoCorrect={false} value={url} onChangeText={setUrl} />
      <TextInput style={input} placeholder="username" placeholderTextColor={theme.textDim} autoCapitalize="none" value={user} onChangeText={setUser} />
      <TextInput style={input} placeholder="password" placeholderTextColor={theme.textDim} secureTextEntry value={pass} onChangeText={setPass} />
      {error ? <Text style={{ color: theme.error, marginBottom: theme.space(2) }}>{error}</Text> : null}
      <Pressable onPress={submit} disabled={busy} style={{ backgroundColor: theme.accent, padding: theme.space(3), borderRadius: 8, alignItems: 'center', opacity: busy ? 0.6 : 1 }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Sign in</Text>
      </Pressable>
    </View>
  )
}
