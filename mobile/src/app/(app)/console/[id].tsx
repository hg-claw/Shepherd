import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, TextInput, ScrollView, Keyboard, KeyboardAvoidingView, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { WebView } from 'react-native-webview'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { openConsole } from '@/api/console'
import { ConsoleSession, type ConsoleStatus } from '@/console/session'
import { TERMINAL_HTML } from '@/console/terminal-html'
import { dataMsg, parseFromWebView } from '@/console/bridge'
import { KEYS, charBytes } from '@/console/keys'
import { useAuth } from '@/store/auth'
import { useServer } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { useTheme } from '@/theme'
import { NavBar, IconButton, Pill, type PillKind } from '@/components/ds'

const BAR: { label: string; bytes: Uint8Array }[] = [
  { label: 'Esc', bytes: KEYS.esc }, { label: 'Tab', bytes: KEYS.tab },
  { label: '^C', bytes: KEYS.ctrlC }, { label: '^D', bytes: KEYS.ctrlD }, { label: '^Z', bytes: KEYS.ctrlZ },
  { label: '↑', bytes: KEYS.up }, { label: '↓', bytes: KEYS.down }, { label: '←', bytes: KEYS.left }, { label: '→', bytes: KEYS.right },
]

// Map the live PTY connection state onto a status Pill.
const STATUS_PILL: Record<ConsoleStatus, { kind: PillKind; label: string }> = {
  open: { kind: 'ok', label: 'connected' },
  connecting: { kind: 'warn', label: 'connecting' },
  closed: { kind: 'err', label: 'closed' },
  error: { kind: 'err', label: 'error' },
}

export default function ConsoleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const baseURL = useAuth((s) => s.baseURL)
  const token = useAuth((s) => s.token)
  const row = useServer(Number(id))
  const host = nullStr(row?.public_alias) || row?.name || 'host'
  const webRef = useRef<WebView>(null)
  const sessionRef = useRef<ConsoleSession | null>(null)
  const readyRef = useRef(false)
  const bufRef = useRef<Uint8Array[]>([])
  const [status, setStatus] = useState<ConsoleStatus>('connecting')
  const [kbVisible, setKbVisible] = useState(false)
  const [copied, setCopied] = useState(false)

  // Track the soft keyboard so the control-key bar can sit above it (iOS) and the
  // home-indicator inset can be dropped while the keyboard covers it.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKbVisible(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbVisible(false))
    return () => { show.remove(); hide.remove() }
  }, [])

  // Copy: ask the WebView for the xterm selection (or full buffer); it posts {copy}.
  const doCopy = () => webRef.current?.injectJavaScript('window.__shepCopy && window.__shepCopy(); true;')

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
    } else if (m.type === 'copy') {
      if (m.text) {
        Clipboard.setStringAsync(m.text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    }
  }
  const sendKey = (bytes: Uint8Array) => sessionRef.current?.write(bytes)
  const closeBack = () => { sessionRef.current?.close(); router.back() }
  const insets = useSafeAreaInsets()
  const t = useTheme()
  const pill = STATUS_PILL[status] ?? STATUS_PILL.connecting

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar
        title={`console · ${host}`}
        backLabel="Host"
        onBack={closeBack}
        actions={<>
          <IconButton name="copy" onPress={doCopy} accessibilityLabel="Copy" />
          <IconButton name="rotate-cw" onPress={start} accessibilityLabel="Reconnect" />
        </>}
      />
      {/* .statline — live connection state strip under the nav bar */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 14, paddingVertical: 9,
        backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border,
      }}>
        <Pill kind={pill.kind}>{pill.label}</Pill>
        <Text style={{ fontFamily: t.mono(), fontSize: 11, color: copied ? t.ok : t.fgDim }}>{copied ? 'Copied ✓' : '24×80 · UTF-8'}</Text>
        <Pressable onPress={closeBack} style={{ marginLeft: 'auto' }}>
          <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.muted }}>Close</Text>
        </Pressable>
      </View>
      <KeyboardAvoidingView style={{ flex: 1, minHeight: 0 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, minHeight: 0 }}>
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
          style={{ flex: 1, backgroundColor: t.bg }}
        />
        <TextInput
          autoFocus autoCorrect={false} autoCapitalize="none" spellCheck={false} blurOnSubmit={false}
          value=""
          onChangeText={(t) => { if (t) sendKey(charBytes(t)) }}
          onKeyPress={(e) => { if (e.nativeEvent.key === 'Backspace') sendKey(KEYS.backspace) }}
          onSubmitEditing={() => sendKey(KEYS.enter)}
          style={{ height: 1, opacity: 0 }}
        />
      </View>
      {/* .keybar — control-key chips. Sits above the keyboard (KeyboardAvoidingView
          lifts it on iOS); drop the home-indicator inset while the keyboard covers it. */}
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        style={{ maxHeight: 38 + 16 + (kbVisible ? 0 : insets.bottom), backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.border }}
        contentContainerStyle={{ alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8 + (kbVisible ? 0 : insets.bottom) }}
      >
        {BAR.map((k) => (
          <Pressable
            key={k.label}
            onPress={() => sendKey(k.bytes)}
            style={({ pressed }) => ({
              minWidth: 42, height: 38, paddingHorizontal: 12, borderRadius: 8,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: pressed ? t.border : t.sunken, borderWidth: 1, borderColor: t.border,
            })}
          >
            <Text style={{ fontFamily: t.mono(), fontSize: 13, color: t.text }}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}
