import { useEffect, useState } from 'react'
import { ScrollView, View, Text, Alert } from 'react-native'
import { Stack, useRouter, type Href } from 'expo-router'
import { useLock } from '@/store/lock'
import { useAuth } from '@/store/auth'
import { hasHardware, isEnrolled } from '@/lib/biometrics'
import { useTheme, useThemeMode } from '@/theme'
import { Header, List, ListRow, Switch, Icon } from '@/components/ds'

function SectionLabel({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  return (
    <Text style={{
      fontFamily: t.font(600), fontSize: 11, color: t.muted,
      letterSpacing: 0.66, textTransform: 'uppercase', paddingHorizontal: 2, paddingVertical: 2,
    }}>
      {children}
    </Text>
  )
}

// .lrow with a trailing control (switch): icon tile + title + right control, no chevron.
function SwitchRow({ icon, title, sub, on, disabled, onChange, testID }: {
  icon: string; title: string; sub?: string; on: boolean; disabled?: boolean
  onChange: (next: boolean) => void; testID?: string
}) {
  const t = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 10, paddingHorizontal: 14 }}>
      <View style={{ width: 30, height: 30, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: t.sunken }}>
        <Icon name={icon} size={16} color={t.muted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: t.fs.md, color: t.text }}>{title}</Text>
        {sub ? <Text style={{ fontSize: 11.5, color: t.muted, marginTop: 1 }}>{sub}</Text> : null}
      </View>
      <Switch on={on} disabled={disabled} onChange={onChange} testID={testID} />
    </View>
  )
}

export default function Settings() {
  const t = useTheme()
  const router = useRouter()
  const { enabled, setEnabled } = useLock()
  const logout = useAuth((s) => s.logout)
  const admin = useAuth((s) => s.admin)
  const baseURL = useAuth((s) => s.baseURL)
  const mode = useThemeMode((s) => s.mode)
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([hasHardware(), isEnrolled()]).then(([hw, en]) => { if (live) setSupported(hw && en) }).catch(() => {})
    return () => { live = false }
  }, [])

  const username = admin?.username ?? 'admin'
  const host = (() => {
    if (!baseURL) return 'server'
    try { return new URL(baseURL).host } catch { return baseURL }
  })()

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <Header title="Settings" sub={`${username} · ${host}`} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 92, gap: 16 }}>
        <View style={{ gap: 8 }}>
          <SectionLabel>Appearance</SectionLabel>
          <List>
            <SwitchRow
              icon={mode === 'dark' ? 'moon' : 'sun'}
              title="Dark mode"
              on={mode === 'dark'}
              onChange={() => { void useThemeMode.getState().toggle() }}
              testID="darkmode-toggle"
            />
          </List>
        </View>

        <View style={{ gap: 8 }}>
          <SectionLabel>Security</SectionLabel>
          <List>
            <SwitchRow
              icon="scan-face"
              title="Require biometric unlock"
              sub={supported ? 'Lock when app is backgrounded' : 'No biometric hardware enrolled.'}
              on={enabled}
              disabled={!supported}
              onChange={(on) => { void setEnabled(on) }}
              testID="lock-toggle"
            />
            <ListRow
              icon="lock"
              title="Lock now"
              chevron={false}
              onPress={() => { if (enabled) useLock.getState().lock() }}
            />
          </List>
        </View>

        <View style={{ gap: 8 }}>
          <SectionLabel>Admin</SectionLabel>
          <List>
            <ListRow
              icon="shield"
              title="Audit log"
              sub="Recent admin actions"
              // Href cast: generated route types (.expo/types) only refresh on the
              // next `expo start`, so a brand-new route isn't in the union yet.
              onPress={() => router.push('/(app)/audit' as Href)}
            />
          </List>
        </View>

        <View style={{ gap: 8 }}>
          <SectionLabel>Account</SectionLabel>
          <List>
            <ListRow icon="user" title="Signed in as" detail={username} chevron={false} />
            <ListRow icon="globe" title="Server" detail={baseURL ?? '—'} chevron={false} mono />
            <ListRow
              icon="log-out"
              iconColor={t.err}
              title="Sign out"
              titleColor={t.err}
              chevron={false}
              onPress={() => {
                Alert.alert('Sign out', `Sign out of ${host}?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Sign out', style: 'destructive', onPress: () => { void logout() } },
                ])
              }}
            />
          </List>
        </View>

        <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.fgDim, textAlign: 'center' }}>
          Shepherd mobile · v1.0.0
        </Text>
      </ScrollView>
    </View>
  )
}
