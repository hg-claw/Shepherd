import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, TextInput, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { openConsole } from '@/api/console'
import { ConsoleSession, type ConsoleStatus } from '@/console/session'
import { TERMINAL_HTML } from '@/console/terminal-html'
import { dataMsg, parseFromWebView } from '@/console/bridge'
import { KEYS, charBytes } from '@/console/keys'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'
import { Screen } from '@/components/Screen'

const BAR: { label: string; bytes: Uint8Array }[] = [
  { label: 'Esc', bytes: KEYS.esc }, { label: 'Tab', bytes: KEYS.tab },
  { label: '^C', bytes: KEYS.ctrlC }, { label: '^D', bytes: KEYS.ctrlD }, { label: '^Z', bytes: KEYS.ctrlZ },
  { label: '↑', bytes: KEYS.up }, { label: '↓', bytes: KEYS.down }, { label: '←', bytes: KEYS.left }, { label: '→', bytes: KEYS.right },
]

export default function ConsoleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const baseURL = useAuth((s) => s.baseURL)
  const token = useAuth((s) => s.token)
  const webRef = useRef<WebView>(null)
  const sessionRef = useRef<ConsoleSession | null>(null)
  const readyRef = useRef(false)
  const bufRef = useRef<Uint8Array[]>([])
  const [status, setStatus] = useState<ConsoleStatus>('connecting')

  const postToWeb = (bytes: Uint8Array) =>
    (webRef.current as WebView & { postMessage(s: string): void } | null)?.postMessage(dataMsg(bytes))
  // The shell prompt often arrives before xterm has finished loading from the CDN.
  // Buffer PTY output until the WebView posts {ready}, then flush — otherwise the
  // first prompt (root@host:~#) is written into a not-yet-ready terminal and lost.
  const pushData = (bytes: Uint8Array) => {
    if (readyRef.current) postToWeb(bytes)
    else bufRef.current.push(bytes)
  }

  const start = async () => {
    sessionRef.current?.close()
    sessionRef.current = null
    setStatus('connecting')
    const { sid } = await openConsole(Number(id), 24, 80)
    sessionRef.current = new ConsoleSession(baseURL ?? '', token, sid, 24, 80, {
      onData: pushData,
      onStatus: setStatus,
    })
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    start()
    return () => sessionRef.current?.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onMessage = (raw: string) => {
    const m = parseFromWebView(raw)
    if (!m) return
    if (m.type === 'input') sessionRef.current?.write(m.bytes)
    else if (m.type === 'resize') sessionRef.current?.resize(m.rows, m.cols)
    else if (m.type === 'ready') {
      readyRef.current = true
      const pending = bufRef.current
      bufRef.current = []
      pending.forEach(postToWeb)
    }
  }
  const sendKey = (bytes: Uint8Array) => sessionRef.current?.write(bytes)
  const insets = useSafeAreaInsets()

  return (
    <Screen edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(2), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, flex: 1 }}>Console · {status}</Text>
        <Pressable onPress={start} style={{ marginRight: theme.space(3) }}><Text style={{ color: theme.accent }}>Reconnect</Text></Pressable>
        <Pressable onPress={() => { sessionRef.current?.close(); router.back() }}><Text style={{ color: theme.textDim }}>Close</Text></Pressable>
      </View>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        // A real https baseUrl gives the page a secure origin; without it the html
        // string loads from an opaque/null origin and Android blocks the https
        // xterm CDN scripts → a blank terminal with no cursor.
        source={{ html: TERMINAL_HTML, baseUrl: 'https://shepherd.app/' }}
        onMessage={(e) => onMessage(e.nativeEvent.data)}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        style={{ flex: 1, backgroundColor: theme.bg }}
      />
      <TextInput
        autoFocus autoCorrect={false} autoCapitalize="none" spellCheck={false} blurOnSubmit={false}
        value=""
        onChangeText={(t) => { if (t) sendKey(charBytes(t)) }}
        onKeyPress={(e) => { if (e.nativeEvent.key === 'Backspace') sendKey(KEYS.backspace) }}
        onSubmitEditing={() => sendKey(KEYS.enter)}
        style={{ height: 1, opacity: 0 }}
      />
      <ScrollView horizontal keyboardShouldPersistTaps="always" style={{ maxHeight: 44, borderTopWidth: 1, borderColor: theme.border, paddingBottom: insets.bottom }} contentContainerStyle={{ alignItems: 'center', padding: theme.space(1) }}>
        {BAR.map((k) => (
          <Pressable key={k.label} onPress={() => sendKey(k.bytes)} style={{ paddingHorizontal: theme.space(3), paddingVertical: theme.space(2), marginHorizontal: theme.space(1), borderRadius: 6, backgroundColor: theme.surface }}>
            <Text style={{ color: theme.text, fontFamily: 'monospace' }}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </Screen>
  )
}
