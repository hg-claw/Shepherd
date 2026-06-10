import { useMemo, useState } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Alert } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { usePluginHosts, deployHost, undeployHost, startHost, stopHost, restartHost, refreshHost, type HostDeployment } from '@/api/plugins'
import { useServers, type ServerRow } from '@/api/servers'
import { nullStr, isOnline } from '@/api/metrics'
import { cmpStr } from '@/lib/format'
import { useTheme } from '@/theme'
import { NavBar, Card, Pill, Button, Empty } from '@/components/ds'
import type { PillKind } from '@/components/ds'

function pillFor(status: string): PillKind {
  if (status === 'failed' || status === 'error') return 'err'
  if (status === 'pending' || status === 'deploying') return 'warn'
  if (status === 'running') return 'ok'
  return 'neutral'
}

// serverName mirrors the web DeployTab: prefer the public alias, then the
// internal name, then a #id fallback so every row is still distinguishable.
function serverName(s: ServerRow): string {
  return nullStr(s.public_alias) || s.name || `#${s.id}`
}

export default function PluginHosts() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const t = useTheme()
  const router = useRouter()
  const q = usePluginHosts(id)
  const serversQ = useServers()
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

  const confirmUndeploy = (server: ServerRow) => {
    Alert.alert(
      `Undeploy from ${serverName(server)}?`,
      'This removes the plugin from the host.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Undeploy', style: 'destructive', onPress: () => { void run(server.id, 'undeploy', () => undeployHost(id, server.id)) } },
      ],
    )
  }

  // Merge every registered server with its deployment (if any), mirroring the
  // web DeployTab: all servers are listed; deployed rows expose lifecycle +
  // undeploy, not-deployed rows expose a single Deploy action. useMemo (not a
  // setState-in-effect) so eslint stays happy and the list is stable.
  const hostByServer = useMemo(() => {
    const m = new Map<number, HostDeployment>()
    for (const h of q.data ?? []) m.set(h.server_id, h)
    return m
  }, [q.data])

  const rows = useMemo(() => {
    const list = [...(serversQ.data ?? [])]
    // Online hosts first, then by display name (cmpStr — Hermes has no Intl).
    list.sort((a, b) => {
      const oa = isOnline(a) ? 0 : 1
      const ob = isOnline(b) ? 0 : 1
      return oa - ob || cmpStr(serverName(a), serverName(b))
    })
    return list.map((server) => ({ server, host: hostByServer.get(server.id) }))
  }, [serversQ.data, hostByServer])

  const renderRow = (server: ServerRow, host: HostDeployment | undefined) => {
    const sid = server.id
    const hostBusy = busy != null && busy.startsWith(`${sid}:`)
    const actionError = actionErrors[sid]
    const ssh = nullStr(server.ssh_host)
    return (
      <Card key={String(sid)} style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ fontFamily: t.font(500), fontSize: t.fs.md, color: t.text }}>
              {serverName(server)}{host?.deployed_version ? ` · ${host.deployed_version}` : ''}
            </Text>
            {ssh ? (
              <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: 11, color: t.muted }}>{ssh}</Text>
            ) : null}
          </View>
          {hostBusy ? <ActivityIndicator size="small" color={t.primary} testID={`busy-${sid}`} /> : null}
          {host ? (
            <Pill kind={pillFor(host.status)}>{host.status}</Pill>
          ) : (
            <Pill kind="neutral">not deployed</Pill>
          )}
        </View>
        {host?.last_error ? (
          <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.err }}>{host.last_error}</Text>
        ) : null}
        {actionError ? (
          <Text testID={`action-error-${sid}`} style={{ fontFamily: t.mono(), fontSize: 12, color: t.err }}>{actionError}</Text>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, opacity: hostBusy ? 0.55 : 1 }}>
          {host ? (
            <>
              <Button testID={`start-${sid}`} variant="outline" disabled={hostBusy} onPress={() => run(sid, 'start', () => startHost(id, sid))}>Start</Button>
              <Button testID={`stop-${sid}`} variant="outline" disabled={hostBusy} onPress={() => run(sid, 'stop', () => stopHost(id, sid))}>Stop</Button>
              <Button testID={`restart-${sid}`} variant="outline" disabled={hostBusy} onPress={() => run(sid, 'restart', () => restartHost(id, sid))}>Restart</Button>
              <Button testID={`refresh-${sid}`} variant="outline" disabled={hostBusy} onPress={() => run(sid, 'refresh', () => refreshHost(id, sid))}>Refresh</Button>
              <Button testID={`undeploy-${sid}`} variant="danger" disabled={hostBusy} onPress={() => confirmUndeploy(server)}>Undeploy</Button>
            </>
          ) : (
            <Button testID={`deploy-${sid}`} variant="primary" icon="plus" disabled={hostBusy} onPress={() => run(sid, 'deploy', () => deployHost(id, { server_id: sid }))}>Deploy</Button>
          )}
        </View>
      </Card>
    )
  }

  const refreshing = q.isRefetching || serversQ.isRefetching
  const onRefresh = () => { void q.refetch(); void serversQ.refetch() }
  const loading = q.isLoading || serversQ.isLoading
  const errored = q.isError || serversQ.isError

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title="Hosts" onBack={() => router.back()} backLabel="Plugin" />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <ActivityIndicator color={t.primary} style={{ marginTop: 24 }} />
        ) : errored ? (
          <Text style={{ color: t.err }}>failed to load hosts</Text>
        ) : rows.length === 0 ? (
          <Empty>No servers registered.</Empty>
        ) : (
          rows.map(({ server, host }) => renderRow(server, host))
        )}
      </ScrollView>
    </View>
  )
}
