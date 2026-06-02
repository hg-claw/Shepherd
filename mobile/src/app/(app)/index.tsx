import { View, Text, Pressable } from 'react-native'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

export default function Home() {
  const { baseURL, admin, logout } = useAuth()
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(5), justifyContent: 'center' }}>
      <Text style={{ color: theme.text, fontSize: 18 }}>Connected to {baseURL}</Text>
      <Text style={{ color: theme.textDim, marginTop: theme.space(1) }}>as {admin?.username ?? '—'}</Text>
      <Pressable onPress={logout} style={{ marginTop: theme.space(6), padding: theme.space(3), borderRadius: 8, borderWidth: 1, borderColor: theme.border, alignItems: 'center' }}>
        <Text style={{ color: theme.text }}>Log out</Text>
      </Pressable>
    </View>
  )
}
