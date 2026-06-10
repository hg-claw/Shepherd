import { useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useRun, useTargetLog, isTerminalStatus, type RunTarget } from '@/api/scripts'
import { useServers, type ServerRow } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { APIError } from '@/api/client'
import { useTheme } from '@/theme'
import { NavBar, Card, Pill, Icon, type PillKind } from '@/components/ds'

function kindOf(status: string): PillKind {
  if (status === 'failed' || status === 'error') return 'err'
  if (status === 'running') return 'warn'
  return 'ok'
}

// TargetLog polls the per-target recording log (every 2s while the target is
// still running, once when terminal) and shows it in a mono scrollable box.
function TargetLog({ target }: { target: RunTarget }) {
  const t = useTheme()
  const pty = typeof target.pty_session_id === 'number' && Number.isFinite(target.pty_session_id)
    ? target.pty_session_id
    : null
  const running = !isTerminalStatus(target.status)
  const q = useTargetLog(pty, running ? 2000 : undefined)

  if (pty == null) {
    return (
      <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim, paddingHorizontal: 14, paddingBottom: 11 }}>
        log not available
      </Text>
    )
  }
  if (q.isLoading) return <ActivityIndicator color={t.primary} style={{ paddingBottom: 11 }} />
  if (q.isError) {
    const notFound = q.error instanceof APIError && q.error.status === 404
    return (
      <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: notFound ? t.fgDim : t.err, paddingHorizontal: 14, paddingBottom: 11 }}>
        {notFound ? 'log not available yet' : 'failed to load log'}
      </Text>
    )
  }
  return (
    <View style={{ marginHorizontal: 14, marginBottom: 11 }}>
      <ScrollView
        nestedScrollEnabled
        style={{ maxHeight: 260, backgroundColor: t.sunken, borderWidth: 1, borderColor: t.border, borderRadius: t.radiusSm }}
        contentContainerStyle={{ padding: 10 }}
      >
        <Text selectable style={{ fontFamily: t.mono(), fontSize: 11.5, lineHeight: 16, color: t.text }}>
          {q.data || '(empty)'}
        </Text>
      </ScrollView>
    </View>
  )
}

function TargetRow({ target, name, first }: { target: RunTarget; name: string; first: boolean }) {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: t.border, borderStyle: 'dashed' }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          paddingVertical: 11, paddingHorizontal: 14,
          backgroundColor: pressed ? t.sunken : 'transparent',
        })}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: 13, color: t.text }}>{name}</Text>
          <Text style={{ fontFamily: t.mono(), fontSize: 10.5, color: t.fgDim, marginTop: 1 }}>
            {open ? 'hide log' : 'view log'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <Pill kind={kindOf(target.status)}>{target.status}</Pill>
          {target.exit_code != null ? (
            <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>{`exit ${target.exit_code}`}</Text>
          ) : null}
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} color={t.fgDim} />
        </View>
      </Pressable>
      {open ? <TargetLog target={target} /> : null}
    </View>
  )
}

export default function RunStatus() {
  const { runId } = useLocalSearchParams<{ runId: string }>()
  const router = useRouter()
  const t = useTheme()
  const q = useRun(Number(runId))
  const servers = useServers().data ?? []
  const [refreshing, setRefreshing] = useState(false)
  const rows: RunTarget[] = q.data ?? []
  const done = rows.filter((r) => isTerminalStatus(r.status)).length
  const allDone = rows.length > 0 && done === rows.length

  const nameOf = (sid: number) => {
    const s: ServerRow | undefined = servers.find((x) => x.id === sid)
    return s ? (nullStr(s.public_alias) || s.name || `#${sid}`) : `#${sid}`
  }
  const onRefresh = async () => {
    setRefreshing(true)
    try { await q.refetch() } finally { setRefreshing(false) }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title={`run #${runId}`} backLabel="Run" onBack={() => router.back()} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 14, paddingBottom: 44, gap: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.muted} />}
      >
        <View>
          <Text style={{ fontFamily: t.mono(600), fontSize: 22, letterSpacing: -0.22, color: t.text }}>
            {`run #${runId}`}
          </Text>
          <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.muted, marginTop: 3 }}>
            {`${done}/${rows.length} hosts complete`}
          </Text>
        </View>

        {q.isLoading ? <ActivityIndicator color={t.primary} /> : null}

        {rows.length > 0 ? (
          <Card>
            {rows.map((r, i) => (
              <TargetRow key={r.id} target={r} name={nameOf(r.server_id)} first={i === 0} />
            ))}
          </Card>
        ) : null}

        {!q.isLoading && rows.length === 0 ? (
          <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.muted }}>queued…</Text>
        ) : null}

        {rows.length > 0 ? (
          <Text style={{ textAlign: 'center', fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>
            {allDone ? 'run complete · pull to refresh' : 'auto-refreshing every 2s'}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  )
}
