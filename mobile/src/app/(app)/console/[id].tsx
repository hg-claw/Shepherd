import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, TextInput, ScrollView, Keyboard, KeyboardAvoidingView, Modal, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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

// expo-clipboard is a NATIVE module. Load it guardedly so a JS-only update on an
// older dev client (one built before this dep was added) doesn't crash the whole
// console — copy just no-ops until the client is rebuilt.
let clipboardSet: ((s: string) => Promise<unknown>) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  clipboardSet = require('expo-clipboard').setStringAsync
} catch {
  clipboardSet = null
}

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
  // Set when POST /console/open itself fails (e.g. agent offline) — without this
  // the screen would sit on 'connecting' forever with no way to retry.
  const [openError, setOpenError] = useState<string | null>(null)
  const [kbVisible, setKbVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  // Non-null while the long-press select-&-copy sheet is open (holds the
  // scrollback text the user can select natively).
  const [selText, setSelText] = useState<string | null>(null)

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
  // The shell prompt often arrives before xterm has finished initializing.
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
    setOpenError(null)
    try {
      const { sid } = await openConsole(Number(id), 24, 80)
      sessionRef.current = new ConsoleSession(baseURL ?? '', token, sid, 24, 80, {
        onData: pushData,
        onStatus: setStatus,
      })
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : 'failed to open console')
      setStatus('error')
    }
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
      if (m.text && clipboardSet) {
        clipboardSet(m.text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    } else if (m.type === 'selecttext') {
      // Long-press → open the native select-&-copy sheet. Dismiss the keyboard so
      // it doesn't cover the sheet.
      Keyboard.dismiss()
      setSelText(m.text)
    }
  }
  const copyAllSelected = () => {
    if (selText && clipboardSet) {
      clipboardSet(selText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
    setSelText(null)
  }
  const sendKey = (bytes: Uint8Array) => sessionRef.current?.write(bytes)
  const closeBack = () => { sessionRef.current?.close(); router.back() }
  const insets = useSafeAreaInsets()
  const t = useTheme()
  const pill = STATUS_PILL[status] ?? STATUS_PILL.connecting
  const canRetry = status === 'closed' || status === 'error'
  const statusDetail = copied ? 'Copied ✓' : openError ?? '24×80 · UTF-8'

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
        <Pressable
          testID="status-pill"
          disabled={!canRetry}
          onPress={() => { void start() }}
          accessibilityLabel={canRetry ? 'Tap to reconnect' : pill.label}
        >
          <Pill kind={pill.kind}>{canRetry ? `${pill.label} · tap to reconnect` : pill.label}</Pill>
        </Pressable>
        <Text
          numberOfLines={1}
          style={{ flex: 1, fontFamily: t.mono(), fontSize: 11, color: copied ? t.ok : openError ? t.err : t.fgDim }}
        >
          {statusDetail}
        </Text>
        <Pressable onPress={closeBack} style={{ marginLeft: 'auto' }}>
          <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.muted }}>Close</Text>
        </Pressable>
      </View>
      <KeyboardAvoidingView style={{ flex: 1, minHeight: 0 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <WebView
          ref={webRef}
          originWhitelist={['*']}
          // xterm is vendored into the html (no CDN scripts), but a real https
          // baseUrl still gives the page a secure origin — harmless, and keeps
          // origin-sensitive WebView behavior consistent across platforms.
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

      {/* Long-press select-&-copy sheet: native text selection over the scrollback. */}
      <Modal visible={selText != null} animationType="slide" transparent onRequestClose={() => setSelText(null)}>
        <View style={{ flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' }}>
          <View style={{
            maxHeight: '82%', backgroundColor: t.surface,
            borderTopLeftRadius: 16, borderTopRightRadius: 16,
            paddingTop: 6, paddingBottom: insets.bottom,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
              <Text style={{ flex: 1, fontFamily: t.font(600), fontSize: 15, color: t.text }}>Select &amp; copy</Text>
              <Pressable onPress={copyAllSelected} accessibilityLabel="Copy all" hitSlop={8}>
                <Text style={{ fontFamily: t.mono(), fontSize: 13, color: t.primary, marginRight: 18 }}>Copy all</Text>
              </Pressable>
              <Pressable testID="select-done" onPress={() => setSelText(null)} accessibilityLabel="Done" hitSlop={8}>
                <Text style={{ fontFamily: t.mono(), fontSize: 13, color: t.muted }}>Done</Text>
              </Pressable>
            </View>
            <Text style={{ fontFamily: t.font(), fontSize: 11.5, color: t.fgDim, paddingHorizontal: 16, paddingBottom: 8 }}>
              Long-press to select, then use the copy menu — or tap Copy all.
            </Text>
            <ScrollView style={{ borderTopWidth: 1, borderTopColor: t.border }} contentContainerStyle={{ padding: 16 }}>
              <Text testID="select-text" selectable style={{ fontFamily: t.mono(), fontSize: 12.5, lineHeight: 18, color: t.text }}>
                {selText ?? ''}
              </Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  )
}
