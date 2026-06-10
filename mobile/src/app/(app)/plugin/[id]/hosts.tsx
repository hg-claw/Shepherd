import { useState } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Alert } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { usePluginHosts, deployHost, undeployHost, startHost, stopHost, restartHost, refreshHost, type HostDeployment } from '@/api/plugins'
import { useTheme } from '@/theme'
import { NavBar, Card, Pill, Button, Field, Input, Empty } from '@/components/ds'
import type { PillKind } from '@/components/ds'

function pillFor(status: string): PillKind {
  if (status === 'failed' || status === 'error') return 'err'
  if (status === 'pending' || status === 'deploying') return 'warn'
  if (status === 'running') return 'ok'
  return 'neutral'
}

export default function PluginHosts() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const t = useTheme()
  const router = useRouter()
  const q = usePluginHosts(id)
  const [serverId, setServerId] = useState('')
  // Which mutation is in flight, e.g. "7:restart" (server_id:action). Guards
  // double-taps: while set, that host's buttons are disabled.
  const [busy, setBusy] = useState<string | null>(null)
  // Last mutation error per server id, rendered inline in that host's card.
  const [actionErrors, setActionErrors] = useState<Record<number, string>>({})

  const run = async (server: number, action: string, fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(`${server}:${action}`)
    setActionErrors((e) => ({ ...e, [server]: '' }))
    try {
      await fn()
      await q.refetch()
    } catch (e) {
      setActionErrors((prev) => ({ ...prev, [server]: e instanceof Error ? e.message : `${action} failed` }))
    } finally {
      setBusy(null)
    }
  }

  const confirmUndeploy = (h: HostDeployment) => {
    Alert.alert(
      `Undeploy from server #${h.server_id}?`,
      'This removes the plugin from the host.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Undeploy', style: 'destructive', onPress: () => { void run(h.server_id, 'undeploy', () => undeployHost(id, h.server_id)) } },
      ],
    )
  }

  const rows = q.data ?? []

  const renderRow = (h: HostDeployment) => {
    const hostBusy = busy != null && busy.startsWith(`${h.server_id}:`)
    const actionError = actionErrors[h.server_id]
    return (
      <Card key={String(h.id)} style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.mono(500), fontSize: t.fs.md, color: t.text }}>
            server #{h.server_id}{h.deployed_version ? ` · ${h.deployed_version}` : ''}
          </Text>
          {hostBusy ? <ActivityIndicator size="small" color={t.primary} testID={`busy-${h.server_id}`} /> : null}
          <Pill kind={pillFor(h.status)}>{h.status}</Pill>
        </View>
        {h.last_error ? (
          <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.err }}>{h.last_error}</Text>
        ) : null}
        {actionError ? (
          <Text testID={`action-error-${h.server_id}`} style={{ fontFamily: t.mono(), fontSize: 12, color: t.err }}>{actionError}</Text>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, opacity: hostBusy ? 0.55 : 1 }}>
          <Button testID={`start-${h.server_id}`} variant="outline" disabled={hostBusy} onPress={() => run(h.server_id, 'start', () => startHost(id, h.server_id))}>Start</Button>
          <Button testID={`stop-${h.server_id}`} variant="outline" disabled={hostBusy} onPress={() => run(h.server_id, 'stop', () => stopHost(id, h.server_id))}>Stop</Button>
          <Button testID={`restart-${h.server_id}`} variant="outline" disabled={hostBusy} onPress={() => run(h.server_id, 'restart', () => restartHost(id, h.server_id))}>Restart</Button>
          <Button testID={`refresh-${h.server_id}`} variant="outline" disabled={hostBusy} onPress={() => run(h.server_id, 'refresh', () => refreshHost(id, h.server_id))}>Refresh</Button>
          <Button testID={`undeploy-${h.server_id}`} variant="danger" disabled={hostBusy} onPress={() => confirmUndeploy(h)}>Undeploy</Button>
        </View>
      </Card>
    )
  }

  const deployTarget = Number(serverId)
  const deployError = actionErrors[deployTarget]

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title="Hosts" onBack={() => router.back()} backLabel="Plugin" />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 12 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={t.primary} />}
        keyboardShouldPersistTaps="handled"
      >
        <Field label="deploy to server">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Input
              style={{ flex: 1 }}
              mono
              value={serverId}
              onChangeText={setServerId}
              keyboardType="number-pad"
              placeholder="server id"
            />
            <Button
              variant="primary"
              icon="plus"
              disabled={busy != null}
              onPress={() => { if (serverId.trim()) void run(deployTarget, 'deploy', () => deployHost(id, { server_id: deployTarget })) }}
            >
              Deploy
            </Button>
          </View>
          {deployError && !rows.some((r) => r.server_id === deployTarget) ? (
            <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.err, marginTop: 6 }}>{deployError}</Text>
          ) : null}
        </Field>

        {q.isLoading ? (
          <ActivityIndicator color={t.primary} style={{ marginTop: 24 }} />
        ) : q.isError ? (
          <Text style={{ color: t.error }}>failed to load hosts</Text>
        ) : rows.length === 0 ? (
          <Empty>Not deployed anywhere.</Empty>
        ) : (
          rows.map(renderRow)
        )}
      </ScrollView>
    </View>
  )
}
