import { View, Text, ScrollView, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useRun, type RunTarget } from '@/api/scripts'
import { useTheme } from '@/theme'
import { NavBar, Card, Pill, type PillKind } from '@/components/ds'

const TERMINAL = new Set(['done', 'success', 'failed', 'error', 'timeout', 'cancelled'])

function kindOf(status: string): PillKind {
  if (status === 'failed' || status === 'error') return 'err'
  if (status === 'running') return 'warn'
  return 'ok'
}

export default function RunStatus() {
  const { runId } = useLocalSearchParams<{ runId: string }>()
  const router = useRouter()
  const t = useTheme()
  const q = useRun(Number(runId))
  const rows: RunTarget[] = q.data ?? []
  const done = rows.filter((r) => TERMINAL.has(r.status)).length

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title={`run #${runId}`} backLabel="Run" onBack={() => router.back()} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 44, gap: 16 }}>
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
              <View
                key={r.id}
                style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  paddingVertical: 11, paddingHorizontal: 14,
                  borderTopWidth: i > 0 ? 1 : 0, borderTopColor: t.border,
                  borderStyle: 'dashed',
                }}
              >
                <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: 13, color: t.text }}>
                  {`server #${r.server_id}`}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <Pill kind={kindOf(r.status)}>{r.status}</Pill>
                  {r.exit_code != null ? (
                    <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>{`exit ${r.exit_code}`}</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </Card>
        ) : null}

        {!q.isLoading && rows.length === 0 ? (
          <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.muted }}>queued…</Text>
        ) : null}

        {rows.length > 0 ? (
          <Text style={{ textAlign: 'center', fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>
            streaming · refreshes as agents report
          </Text>
        ) : null}
      </ScrollView>
    </View>
  )
}
