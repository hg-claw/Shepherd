import { useEffect, useRef, useState } from 'react'
import {
  View, Text, Pressable, FlatList, ScrollView, ActivityIndicator, AppState,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { usePluginHosts, pluginLogsWSURL } from '@/api/plugins'
import { useServers, type ServerRow } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { useAuth } from '@/store/auth'
import { useTheme } from '@/theme'
import { NavBar, Pill, Button, Empty, type PillKind } from '@/components/ds'

type LogLine = { ts: string; level: string; line: string }
type WSStatus = 'connecting' | 'open' | 'closed' | 'error'

const MAX_LINES = 2000 // ring buffer cap, matches the web logs tab
const FLUSH_MS = 200 // throttle window for batching message → state flushes

const STATUS_PILL: Record<WSStatus, { kind: PillKind; label: string }> = {
  connecting: { kind: 'warn', label: 'connecting' },
  open: { kind: 'ok', label: 'live' },
  closed: { kind: 'err', label: 'closed' },
  error: { kind: 'err', label: 'error' },
}

// The log box is always dark (like a terminal), independent of the app theme —
// same as the web logs tab's fixed #0a0a0b panel.
const BOX_BG = '#0a0a0b'
const BOX_FG = '#e4e4e7'
const BOX_DIM = '#71717a'

// RN's WebSocket accepts a third options arg carrying headers — that's how the
// bearer reaches the admin mux (same trick as the console session). The TS lib
// types don't know about it, hence the local constructor type.
type RNWebSocket = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket

export default function PluginLogsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const t = useTheme()
  const baseURL = useAuth((s) => s.baseURL)
  const token = useAuth((s) => s.token)
  const hostsQ = usePluginHosts(id)
  const servers = useServers().data ?? []

  // Selected host: an explicit pick wins; otherwise derive the first deployed
  // host from the query data (derived, NOT mirrored in an effect).
  const hosts = hostsQ.data ?? []
  const [picked, setPicked] = useState<number | null>(null)
  const serverID = picked ?? hosts[0]?.server_id ?? null

  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<WSStatus>('connecting')
  const [paused, setPaused] = useState(false)
  // Pause is a display gate read inside onmessage (a ref), NOT an effect dep —
  // so toggling it neither reconnects the socket nor clears the buffer.
  const pausedRef = useRef(false)
  // Bumping epoch re-runs the connect effect → tap-to-reconnect. Without this a
  // socket killed by sleep/wake would silently freeze the tail forever.
  const [epoch, setEpoch] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const listRef = useRef<FlatList<LogLine>>(null)
  // Stick to the bottom on new lines unless the user has scrolled up.
  const atBottomRef = useRef(true)

  useEffect(() => {
    if (!baseURL || serverID == null) return
    // Lines arrive in bursts; buffer them locally and flush on a leading-edge
    // throttle so a chatty stream doesn't re-render the list per line.
    let pending: LogLine[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let torndown = false
    const flush = () => {
      if (!pending.length) return
      const batch = pending
      pending = []
      setLines((prev) => [...prev, ...batch].slice(-MAX_LINES))
    }
    const url = pluginLogsWSURL(baseURL, id, serverID)
    const WS = (global as unknown as { WebSocket: RNWebSocket }).WebSocket
    const ws = new WS(url, undefined, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
    wsRef.current = ws
    ws.onopen = () => setStatus('open')
    ws.onmessage = (e: { data?: unknown }) => {
      if (typeof e.data !== 'string') return
      if (pausedRef.current) return // pause drops incoming lines, like the web tab
      try { pending.push(JSON.parse(e.data) as LogLine) } catch { return }
      if (timer == null) {
        flush()
        timer = setTimeout(() => { timer = null; flush() }, FLUSH_MS)
      }
    }
    ws.onerror = () => { if (!torndown) setStatus('error') }
    ws.onclose = () => { if (!torndown) setStatus('closed') }
    return () => {
      torndown = true
      wsRef.current = null
      if (timer != null) clearTimeout(timer)
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      ws.close()
    }
  }, [baseURL, token, id, serverID, epoch])

  // On foreground, if the socket died while asleep, reconnect immediately.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return
      const ws = wsRef.current
      if (!ws || ws.readyState === 2 || ws.readyState === 3) {
        setStatus('connecting')
        setEpoch((e) => e + 1)
      }
    })
    return () => sub.remove()
  }, [])

  const reconnect = () => {
    setStatus('connecting')
    setEpoch((e) => e + 1)
  }
  const pickHost = (sid: number) => {
    if (sid === serverID) return
    setPicked(sid)
    setLines([])
    setStatus('connecting')
  }
  const togglePause = () => {
    pausedRef.current = !pausedRef.current
    setPaused(pausedRef.current)
  }

  const nameOf = (sid: number) => {
    const s: ServerRow | undefined = servers.find((x) => x.id === sid)
    return s ? (nullStr(s.public_alias) || s.name || `#${sid}`) : `#${sid}`
  }

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    atBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48
  }

  const pill = STATUS_PILL[status]
  const canRetry = status === 'closed' || status === 'error'

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title="Logs" onBack={() => router.back()} backLabel="Plugin" />

      {hostsQ.isLoading ? (
        <ActivityIndicator testID="logs-loading" color={t.primary} style={{ marginTop: 32 }} />
      ) : hosts.length === 0 ? (
        <Empty>Not deployed anywhere.</Empty>
      ) : (
        <>
          {/* host picker — chips across the plugin's deployed hosts */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border }}
            contentContainerStyle={{ gap: 6, paddingHorizontal: 14, paddingVertical: 9, alignItems: 'center' }}
          >
            {hosts.map((h) => {
              const active = h.server_id === serverID
              return (
                <Pressable
                  key={String(h.id)}
                  testID={`host-${h.server_id}`}
                  onPress={() => pickHost(h.server_id)}
                  style={{
                    height: 30, paddingHorizontal: 12, borderRadius: t.radius, justifyContent: 'center',
                    backgroundColor: active ? t.sunken : 'transparent',
                    borderWidth: 1, borderColor: active ? t.borderStrong : t.border,
                  }}
                >
                  <Text style={{ fontFamily: t.mono(active ? 500 : 400), fontSize: 12, color: active ? t.text : t.muted }}>
                    {nameOf(h.server_id)}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>

          {/* controls — status pill (tap reconnects when dead), pause/resume, clear */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            paddingHorizontal: 14, paddingVertical: 8,
            backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border,
          }}>
            <Pressable
              testID="status-pill"
              disabled={!canRetry}
              onPress={reconnect}
              accessibilityLabel={canRetry ? 'Tap to reconnect' : pill.label}
            >
              <Pill kind={pill.kind}>{canRetry ? `${pill.label} · tap to reconnect` : pill.label}</Pill>
            </Pressable>
            {paused ? <Pill kind="warn">paused</Pill> : null}
            <View style={{ flex: 1 }} />
            <Button testID="pause-btn" variant="outline" onPress={togglePause}>{paused ? 'Resume' : 'Pause'}</Button>
            <Button testID="clear-btn" variant="outline" onPress={() => setLines([])}>Clear</Button>
          </View>

          {/* live tail — mono, always-dark terminal-style box */}
          <FlatList
            ref={listRef}
            testID="log-list"
            data={lines}
            keyExtractor={(_, i) => String(i)}
            renderItem={({ item }) => (
              <Text selectable style={{ fontFamily: t.mono(), fontSize: 11.5, lineHeight: 17, color: BOX_FG }}>
                <Text style={{ color: BOX_DIM }}>{`${item.ts.slice(11, 19)}  `}</Text>
                {item.line}
              </Text>
            )}
            onScroll={onScroll}
            scrollEventThrottle={32}
            onContentSizeChange={() => {
              if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false })
            }}
            style={{ flex: 1, backgroundColor: BOX_BG }}
            contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
            ListEmptyComponent={
              <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: BOX_DIM }}>waiting for log lines…</Text>
            }
          />
        </>
      )}
    </View>
  )
}
