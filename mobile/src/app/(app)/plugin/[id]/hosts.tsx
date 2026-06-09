import { useState } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native'
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
  const run = async (fn: () => Promise<unknown>) => { await fn(); await q.refetch() }
  const rows = q.data ?? []

  const renderRow = (h: HostDeployment) => (
    <Card key={String(h.id)} style={{ padding: 14, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.mono(500), fontSize: t.fs.md, color: t.text }}>
          server #{h.server_id}{h.deployed_version ? ` · ${h.deployed_version}` : ''}
        </Text>
        <Pill kind={pillFor(h.status)}>{h.status}</Pill>
      </View>
      {h.last_error ? (
        <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.err }}>{h.last_error}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button testID={`start-${h.server_id}`} variant="outline" onPress={() => run(() => startHost(id, h.server_id))}>Start</Button>
        <Button testID={`stop-${h.server_id}`} variant="outline" onPress={() => run(() => stopHost(id, h.server_id))}>Stop</Button>
        <Button testID={`restart-${h.server_id}`} variant="outline" onPress={() => run(() => restartHost(id, h.server_id))}>Restart</Button>
        <Button testID={`refresh-${h.server_id}`} variant="outline" onPress={() => run(() => refreshHost(id, h.server_id))}>Refresh</Button>
        <Button testID={`undeploy-${h.server_id}`} variant="danger" onPress={() => run(() => undeployHost(id, h.server_id))}>Undeploy</Button>
      </View>
    </Card>
  )

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
              onPress={() => { if (serverId.trim()) run(() => deployHost(id, { server_id: Number(serverId) })) }}
            >
              Deploy
            </Button>
          </View>
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
