import { useMemo, useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, Alert } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  useInbounds, deleteInbound, invalidateInbounds, shareURLFor, DeleteInboundConflict,
  type ProxyPluginID, type ProxyInboundFull,
} from '@/api/inbounds'
import { usePluginHosts, type HostDeployment } from '@/api/plugins'
import { useServers } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { cmpStr } from '@/lib/format'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Card, Button, Pill, Empty, IconButton } from '@/components/ds'

// expo-clipboard is a NATIVE module — load it guardedly so a JS-only update on an
// older dev client doesn't crash the screen; Copy just no-ops until rebuilt.
let clipboardSet: ((s: string) => Promise<unknown>) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  clipboardSet = require('expo-clipboard').setStringAsync
} catch {
  clipboardSet = null
}

export function isInboundsPlugin(id?: string): id is ProxyPluginID {
  return id === 'singbox' || id === 'xray'
}

// hostStatusKind maps a deploy status to a Pill tone (running = ok, else neutral).
export function hostStatusKind(status?: string): 'ok' | 'neutral' {
  return status === 'running' ? 'ok' : 'neutral'
}

// ── error / retry ladder (mirrors status.tsx) ─────────────────────────────────

function ErrorRetry({ children, onRetry }: { children: string; onRetry: () => void }) {
  const t = useTheme()
  return (
    <View style={{ alignItems: 'center', gap: 12, padding: 24 }}>
      <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.err }}>{children}</Text>
      <Button variant="outline" icon="refresh-cw" onPress={onRetry}>Retry</Button>
    </View>
  )
}

// ── one inbound row ────────────────────────────────────────────────────────────

function InboundCard({
  plugin, inbound, hostname, byID, dependents, onEdit, onDelete,
}: {
  plugin: ProxyPluginID
  inbound: ProxyInboundFull
  hostname: string
  byID: Map<number, ProxyInboundFull>
  dependents: number
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useTheme()
  const isRelay = inbound.role === 'relay'
  const shareURL = shareURLFor(plugin, inbound, hostname, byID)
  const canCopy = !!shareURL && !!clipboardSet
  const [copied, setCopied] = useState(false)

  const copy = () => {
    if (!shareURL || !clipboardSet) return
    void clipboardSet(shareURL)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 12, gap: 8, borderTopWidth: 1, borderTopColor: t.border }}>
      {/* tag + protocol + port — sibling Views in a flex row (no View-in-Text) */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.mono(500), fontSize: t.fs.sm, color: t.text }}>
          {inbound.tag}
        </Text>
        <Pill kind="neutral">{inbound.protocol}</Pill>
        <Text style={{ marginLeft: 'auto', fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
          :{inbound.port}
        </Text>
      </View>

      {/* role + alias + relay upstream — Pills (Views) as siblings, never in Text */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Pill kind={isRelay ? 'ok' : 'neutral'}>{inbound.role}</Pill>
        {inbound.alias ? (
          <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>{inbound.alias}</Text>
        ) : null}
        {isRelay && inbound.upstream_tag ? (
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.mono(), fontSize: t.fs.xs, color: t.fgDim }}>
            → {inbound.upstream_tag}
            {inbound.upstream_server_name ? ` @ ${inbound.upstream_server_name}` : ''}
          </Text>
        ) : null}
      </View>

      {/* actions */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
        {canCopy ? (
          <Button testID={`copy-${inbound.id}`} variant="outline" icon="copy" onPress={copy}>
            {copied ? 'Copied' : 'Copy URL'}
          </Button>
        ) : null}
        <Button testID={`edit-${inbound.id}`} variant="ghost" icon="settings" onPress={onEdit}>Edit</Button>
        <View style={{ marginLeft: 'auto' }}>
          <Button
            testID={`delete-${inbound.id}`}
            variant="danger"
            icon="x"
            disabled={dependents > 0}
            onPress={onDelete}
          >
            {dependents > 0 ? `${dependents} relay(s)` : 'Delete'}
          </Button>
        </View>
      </View>
    </View>
  )
}

// ── server section ─────────────────────────────────────────────────────────────

function ServerSection({
  plugin, serverID, name, hostname, host, inbounds, byID, dependentsByID, onEdit, onDelete, onAdd,
}: {
  plugin: ProxyPluginID
  serverID: number
  name: string
  hostname: string
  host?: HostDeployment
  inbounds: ProxyInboundFull[]
  byID: Map<number, ProxyInboundFull>
  dependentsByID: Map<number, number>
  onEdit: (i: ProxyInboundFull) => void
  onDelete: (i: ProxyInboundFull) => void
  onAdd: (serverID: number) => void
}) {
  const t = useTheme()
  return (
    <Card>
      {/* header: name + ssh_host + status pill + Add — siblings, not in Text */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: t.border,
      }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: t.font(600), fontSize: 12.5, color: t.text }}>{name}</Text>
          <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.fgDim, marginTop: 1 }}>
            {hostname || '—'}
          </Text>
        </View>
        {host ? <Pill kind={hostStatusKind(host.status)}>{host.status}</Pill> : null}
        <IconButton name="plus" accessibilityLabel={`add-${serverID}`} onPress={() => onAdd(serverID)} />
      </View>

      {inbounds.length === 0 ? (
        <Empty>No inbounds on this server.</Empty>
      ) : (
        inbounds.map((i) => (
          <InboundCard
            key={String(i.id)}
            plugin={plugin}
            inbound={i}
            hostname={hostname}
            byID={byID}
            dependents={dependentsByID.get(i.id) ?? 0}
            onEdit={() => onEdit(i)}
            onDelete={() => onDelete(i)}
          />
        ))
      )}
    </Card>
  )
}

// ── screen body ─────────────────────────────────────────────────────────────────

function InboundsList({ plugin }: { plugin: ProxyPluginID }) {
  const t = useTheme()
  const router = useRouter()
  const qc = useQueryClient()

  const inboundsQ = useInbounds(plugin)
  const hostsQ = usePluginHosts(plugin)
  const serversQ = useServers()

  const inbounds = useMemo(() => inboundsQ.data ?? [], [inboundsQ.data])

  // server lookups (name + ssh_host via servers join). ssh_host is a real
  // sql.NullString {String,Valid} → MUST go through nullStr().
  const serverMeta = useMemo(() => {
    const m = new Map<number, { name: string; hostname: string }>()
    for (const s of serversQ.data ?? []) {
      m.set(s.id, { name: nullStr(s.public_alias) || s.name || `#${s.id}`, hostname: nullStr(s.ssh_host) })
    }
    return m
  }, [serversQ.data])

  const hostByServer = useMemo(() => {
    const m = new Map<number, HostDeployment>()
    for (const h of hostsQ.data ?? []) m.set(h.server_id, h)
    return m
  }, [hostsQ.data])

  // group inbounds by server_id
  const groups = useMemo(() => {
    const m = new Map<number, ProxyInboundFull[]>()
    for (const i of inbounds) {
      const arr = m.get(i.server_id) ?? []
      arr.push(i)
      m.set(i.server_id, arr)
    }
    return m
  }, [inbounds])

  // inbound-by-id (for forward-relay share URLs) + relay-dependent counts per landing
  const byID = useMemo(() => {
    const m = new Map<number, ProxyInboundFull>()
    for (const i of inbounds) m.set(i.id, i)
    return m
  }, [inbounds])

  const dependentsByID = useMemo(() => {
    const m = new Map<number, number>()
    for (const i of inbounds) {
      if (i.role === 'relay' && i.upstream_inbound_id != null) {
        m.set(i.upstream_inbound_id, (m.get(i.upstream_inbound_id) ?? 0) + 1)
      }
    }
    return m
  }, [inbounds])

  // server ids to render: every deployed host, plus any server that carries an
  // inbound even if no deploy row. Sorted by display name (cmpStr — no Intl).
  const serverIDs = useMemo(() => {
    const set = new Set<number>()
    for (const h of hostsQ.data ?? []) set.add(h.server_id)
    for (const i of inbounds) set.add(i.server_id)
    return Array.from(set).sort((a, b) => cmpStr(
      serverMeta.get(a)?.name ?? `#${a}`,
      serverMeta.get(b)?.name ?? `#${b}`,
    ))
  }, [hostsQ.data, inbounds, serverMeta])

  const refreshing = inboundsQ.isRefetching || hostsQ.isRefetching || serversQ.isRefetching
  const onRefresh = () => {
    void inboundsQ.refetch()
    void hostsQ.refetch()
    void serversQ.refetch()
  }

  const goCreate = (serverID: number) =>
    router.push(`/(app)/plugin/${plugin}/inbound-form?mode=create&serverId=${serverID}`)
  const goEdit = (i: ProxyInboundFull) =>
    router.push(`/(app)/plugin/${plugin}/inbound-form?mode=edit&inboundId=${i.id}`)

  const confirmDelete = (i: ProxyInboundFull) => {
    Alert.alert(
      `Delete ${i.tag}?`,
      'This removes the inbound and triggers a redeploy.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await deleteInbound(plugin, i.id)
                invalidateInbounds(qc, plugin)
              } catch (e) {
                if (e instanceof DeleteInboundConflict) {
                  const ids = e.relayInboundIDs.length ? ` (relay ids: ${e.relayInboundIDs.join(', ')})` : ''
                  Alert.alert('Cannot delete', `${e.message}${ids}`)
                } else {
                  Alert.alert('Delete failed', e instanceof Error ? e.message : 'delete failed')
                }
              }
            })()
          },
        },
      ],
    )
  }

  if (inboundsQ.isLoading || hostsQ.isLoading) {
    return <ActivityIndicator testID="inbounds-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (inboundsQ.isError) {
    return <ErrorRetry onRetry={() => { void inboundsQ.refetch() }}>Failed to load inbounds.</ErrorRetry>
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
    >
      {serverIDs.length === 0 ? (
        <Empty>Not deployed anywhere — deploy the plugin to a server first.</Empty>
      ) : (
        serverIDs.map((sid) => {
          const meta = serverMeta.get(sid)
          return (
            <ServerSection
              key={String(sid)}
              plugin={plugin}
              serverID={sid}
              name={meta?.name ?? `#${sid}`}
              hostname={meta?.hostname ?? ''}
              host={hostByServer.get(sid)}
              inbounds={groups.get(sid) ?? []}
              byID={byID}
              dependentsByID={dependentsByID}
              onEdit={goEdit}
              onDelete={confirmDelete}
              onAdd={goCreate}
            />
          )
        })
      )}
    </ScrollView>
  )
}

// ── screen ───────────────────────────────────────────────────────────────────

export default function InboundsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Inbounds' }} />
      <NavBar
        title="Inbounds"
        onBack={() => router.back()}
        backLabel="Plugin"
        actions={
          isInboundsPlugin(id) ? (
            <IconButton
              name="plus"
              accessibilityLabel="new-inbound"
              onPress={() => router.push(`/(app)/plugin/${id}/inbound-form?mode=create`)}
            />
          ) : undefined
        }
      />
      {isInboundsPlugin(id) ? (
        <InboundsList plugin={id} />
      ) : (
        <Empty>Inbounds are only available for sing-box and xray.</Empty>
      )}
    </Screen>
  )
}
