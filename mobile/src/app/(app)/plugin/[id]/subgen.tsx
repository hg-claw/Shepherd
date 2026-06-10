import { useMemo, useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, Pressable, Alert } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  useSubscriptions, useTemplates, useSubscriptionInbounds,
  updateSubscription, deleteSubscription, rotateToken, deleteTemplate,
  buildSubURL, SUB_TARGETS,
  type Subscription, type Template, type SubTarget, type Selection,
} from '@/api/subgen'
import { useProxyInbounds, type ProxyInbound } from '@/api/plugins'
import { useAuth } from '@/store/auth'
import { cmpStr } from '@/lib/format'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Card, CardHead, Pill, Button, Segmented, Switch, Empty, type PillKind } from '@/components/ds'

// expo-clipboard is a NATIVE module — load it guardedly so an un-rebuilt dev
// client doesn't crash; copy just no-ops until the client is rebuilt (PR 110/111).
let clipboardSet: ((s: string) => Promise<unknown>) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  clipboardSet = require('expo-clipboard').setStringAsync
} catch {
  clipboardSet = null
}

// subgen is HostAware:false; index.tsx gates the Subscriptions row by this id.
export function hasSubgenView(id?: string): boolean {
  return id === 'subgen'
}

type Tab = 'subscriptions' | 'templates'

// templateLabel resolves a subscription's template_id to a human name via the
// templates list, falling back to the raw id when the template was deleted.
export function templateLabel(templateID: number, templates: Template[]): string {
  const tpl = templates.find((x) => x.id === templateID)
  return tpl ? tpl.name : `#${templateID}`
}

// keyOf is the de-dupe key for a node selection (source + inbound id).
export function keyOf(sel: { source: string; inbound_id: number }): string {
  return `${sel.source}:${sel.inbound_id}`
}

// ── shared bits ───────────────────────────────────────────────────────────────

function ErrorRetry({ children, onRetry }: { children: string; onRetry: () => void }) {
  const t = useTheme()
  return (
    <View style={{ alignItems: 'center', gap: 12, padding: t.space(6) }}>
      <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.err }}>{children}</Text>
      <Button variant="outline" icon="refresh-cw" onPress={onRetry}>Retry</Button>
    </View>
  )
}

const TARGET_LABEL: Record<SubTarget, string> = {
  surge: 'Surge',
  shadowrocket: 'Shadowrocket',
  clash: 'Clash',
  quantumultx: 'QuanX',
}

// ── subscription row (inline-expanding; the ds kit has no Modal) ────────────────

function SubRow({
  sub, templateName, baseURL, onChanged,
}: {
  sub: Subscription
  templateName: string
  baseURL: string | null
  onChanged: () => void
}) {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<SubTarget>('surge')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read-only bundled nodes; only fetched once the row is expanded. The grouped
  // multi-select editor + PUT replace are deferred to web.
  const inboundsQ = useSubscriptionInbounds(open ? sub.id : null)
  const xrayQ = useProxyInbounds('xray', open ? -1 : null) // -1 = all servers
  const singboxQ = useProxyInbounds('singbox', open ? -1 : null)

  const url = buildSubURL(baseURL, sub.token, target)

  // Resolve each Selection to a node tag via the inbound lists (Selection has no
  // tag/server names of its own; cross-reference by source + inbound_id).
  const nodeLabels = useMemo(() => {
    const byKey = new Map<string, ProxyInbound>()
    for (const i of xrayQ.data ?? []) byKey.set(`xray:${i.id}`, i)
    for (const i of singboxQ.data ?? []) byKey.set(`singbox:${i.id}`, i)
    const seen = new Set<string>()
    const out: string[] = []
    for (const sel of (inboundsQ.data ?? []) as Selection[]) {
      const k = keyOf(sel)
      if (seen.has(k)) continue
      seen.add(k)
      const m = byKey.get(k)
      out.push(m ? `${m.tag} · ${m.server_name}` : `${sel.source} #${sel.inbound_id}`)
    }
    return out.sort(cmpStr)
  }, [inboundsQ.data, xrayQ.data, singboxQ.data])

  // PATCH sends the FULL triple — the Go body zero-fills omitted fields, so an
  // enabled-only body would blank the name + zero the template_id.
  const toggleEnabled = async (next: boolean) => {
    setBusy(true); setError(null)
    try {
      await updateSubscription(sub.id, { name: sub.name, template_id: sub.template_id, enabled: next })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update failed')
    } finally { setBusy(false) }
  }

  const copy = () => {
    if (!url || !clipboardSet) return
    void clipboardSet(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const regenerate = () => {
    Alert.alert(
      'Regenerate token?',
      `Existing clients of "${sub.name}" will stop updating until re-imported with the new URL.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Regenerate', style: 'destructive', onPress: async () => {
            setBusy(true); setError(null)
            try { await rotateToken(sub.id); onChanged() }
            catch (e) { setError(e instanceof Error ? e.message : 'rotate failed') }
            finally { setBusy(false) }
          },
        },
      ],
    )
  }

  const revoke = () => {
    Alert.alert(
      'Revoke subscription?',
      `Delete "${sub.name}" permanently. Its URL stops working immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke', style: 'destructive', onPress: async () => {
            setBusy(true); setError(null)
            try { await deleteSubscription(sub.id); onChanged() }
            catch (e) { setError(e instanceof Error ? e.message : 'delete failed') }
            finally { setBusy(false) }
          },
        },
      ],
    )
  }

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: t.border }}>
      <Pressable
        testID={`sub-${sub.id}`}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 10,
          paddingHorizontal: 14, paddingVertical: 11,
          backgroundColor: pressed ? t.sunken : 'transparent',
        })}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: t.font(500), fontSize: t.fs.md, color: t.text }}>
            {sub.name}
          </Text>
          <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted, marginTop: 1 }}>
            {templateName}
          </Text>
        </View>
        <Pill kind={sub.enabled ? 'ok' : 'neutral'}>{sub.enabled ? 'enabled' : 'disabled'}</Pill>
      </Pressable>

      {open ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>Enabled</Text>
            <View style={{ marginLeft: 'auto' }}>
              <Switch testID={`sub-toggle-${sub.id}`} on={sub.enabled} disabled={busy} onChange={toggleEnabled} />
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <Text style={{ fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>Import URL</Text>
            <Segmented<SubTarget>
              value={target}
              onChange={setTarget}
              options={SUB_TARGETS.map((tg) => ({ value: tg, label: TARGET_LABEL[tg] }))}
            />
            <View style={{
              backgroundColor: t.sunken, borderWidth: 1, borderColor: t.border, borderRadius: t.radius,
              paddingHorizontal: 11, paddingVertical: 9,
            }}>
              <Text testID={`sub-url-${sub.id}`} selectable style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.muted }}>
                {url || 'sign in to build URL'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button testID={`sub-copy-${sub.id}`} variant="outline" icon="copy" onPress={copy} disabled={!url}>
                {copied ? 'Copied ✓' : 'Copy'}
              </Button>
              <Button testID={`sub-rotate-${sub.id}`} variant="outline" icon="rotate-cw" disabled={busy} onPress={regenerate}>
                Regenerate
              </Button>
            </View>
          </View>

          <View style={{ gap: 6 }}>
            <Text style={{ fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>Included nodes</Text>
            {inboundsQ.isLoading ? (
              <ActivityIndicator testID={`sub-nodes-loading-${sub.id}`} color={t.primary} style={{ alignSelf: 'flex-start' }} />
            ) : inboundsQ.isError ? (
              <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.err }}>failed to load nodes</Text>
            ) : nodeLabels.length === 0 ? (
              <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim }}>no nodes bundled — edit on web</Text>
            ) : (
              nodeLabels.map((label) => (
                <Text key={label} numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.muted }}>
                  · {label}
                </Text>
              ))
            )}
            <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>
              Editing the node selection is done on the web console.
            </Text>
          </View>

          {error ? <Text style={{ fontFamily: t.mono(), fontSize: 12.5, color: t.err }}>{error}</Text> : null}

          <Button testID={`sub-revoke-${sub.id}`} variant="danger" icon="x" block disabled={busy} onPress={revoke}>
            Revoke subscription
          </Button>
        </View>
      ) : null}
    </View>
  )
}

// ── subscriptions tab ───────────────────────────────────────────────────────────

function SubscriptionsTab({ pluginID }: { pluginID: string }) {
  const t = useTheme()
  const router = useRouter()
  const qc = useQueryClient()
  const baseURL = useAuth((s) => s.baseURL)
  const subsQ = useSubscriptions()
  const tplQ = useTemplates()

  const templates = tplQ.data ?? []
  const subs = useMemo(
    () => [...(subsQ.data ?? [])].sort((a, b) => cmpStr(a.name, b.name)),
    [subsQ.data],
  )

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['subgen-subscriptions'] })
    void qc.invalidateQueries({ queryKey: ['subgen-sub-inbounds'] })
  }

  const onRefresh = () => {
    void subsQ.refetch()
    void tplQ.refetch()
  }

  if (subsQ.isLoading) {
    return <ActivityIndicator testID="subs-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (subsQ.isError) {
    return <ErrorRetry onRetry={() => { void subsQ.refetch() }}>Failed to load subscriptions.</ErrorRetry>
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
      refreshControl={
        <RefreshControl
          refreshing={subsQ.isRefetching || tplQ.isRefetching}
          onRefresh={onRefresh}
          tintColor={t.primary}
        />
      }
    >
      <Button
        testID="sub-new"
        variant="primary"
        icon="plus"
        block
        onPress={() => router.push(`/(app)/plugin/${pluginID}/subgen-sub-new`)}
      >
        New subscription
      </Button>

      <Card>
        <CardHead>Subscriptions</CardHead>
        {subs.length === 0 ? (
          <Empty>No subscriptions yet.</Empty>
        ) : (
          subs.map((s) => (
            <SubRow
              key={String(s.id)}
              sub={s}
              templateName={templateLabel(s.template_id, templates)}
              baseURL={baseURL}
              onChanged={invalidate}
            />
          ))
        )}
      </Card>
    </ScrollView>
  )
}

// ── templates tab ────────────────────────────────────────────────────────────

function TemplateRow({ tpl, onChanged }: { tpl: Template; onChanged: () => void }) {
  const t = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind: PillKind = tpl.builtin ? 'neutral' : 'ok'

  const remove = () => {
    Alert.alert(
      'Delete template?',
      `Delete the custom template "${tpl.name}".`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            setBusy(true); setError(null)
            try { await deleteTemplate(tpl.id); onChanged() }
            catch (e) { setError(e instanceof Error ? e.message : 'delete failed') }
            finally { setBusy(false) }
          },
        },
      ],
    )
  }

  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: 1, borderTopColor: t.border,
    }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: t.font(500), fontSize: t.fs.md, color: t.text }}>
          {tpl.name}
        </Text>
        {error ? (
          <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.err, marginTop: 1 }}>{error}</Text>
        ) : null}
      </View>
      <Pill kind={kind}>{tpl.builtin ? 'built-in' : 'custom'}</Pill>
      {tpl.builtin ? null : (
        <Button testID={`tpl-del-${tpl.id}`} variant="danger" icon="x" disabled={busy} onPress={remove}>
          Delete
        </Button>
      )}
    </View>
  )
}

function TemplatesTab() {
  const t = useTheme()
  const qc = useQueryClient()
  const tplQ = useTemplates()
  const templates = useMemo(
    () => [...(tplQ.data ?? [])].sort((a, b) => cmpStr(a.name, b.name)),
    [tplQ.data],
  )

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['subgen-templates'] }) }

  if (tplQ.isLoading) {
    return <ActivityIndicator testID="tpls-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (tplQ.isError) {
    return <ErrorRetry onRetry={() => { void tplQ.refetch() }}>Failed to load templates.</ErrorRetry>
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
      refreshControl={<RefreshControl refreshing={tplQ.isRefetching} onRefresh={() => { void tplQ.refetch() }} tintColor={t.primary} />}
    >
      <Card>
        <CardHead>Templates</CardHead>
        {templates.length === 0 ? (
          <Empty>No templates.</Empty>
        ) : (
          templates.map((tpl) => <TemplateRow key={String(tpl.id)} tpl={tpl} onChanged={invalidate} />)
        )}
      </Card>
      <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.fgDim, textAlign: 'center' }}>
        Creating & editing template rules is done on the web console.
      </Text>
    </ScrollView>
  )
}

// ── screen ────────────────────────────────────────────────────────────────────

export default function SubgenScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const t = useTheme()
  // Default to Subscriptions (the high-value tab); derived/owned by useState,
  // never set in an effect.
  const [tab, setTab] = useState<Tab>('subscriptions')

  if (!hasSubgenView(id)) {
    return (
      <Screen edges={['bottom']}>
        <Stack.Screen options={{ title: 'Subscriptions' }} />
        <NavBar title="Subscriptions" onBack={() => router.back()} backLabel="Plugin" />
        <Empty>No subscription view for this plugin.</Empty>
      </Screen>
    )
  }

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Subscriptions' }} />
      <NavBar title="Subscriptions" onBack={() => router.back()} backLabel="Plugin" />
      <View style={{
        paddingHorizontal: 14, paddingVertical: 9,
        borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface,
      }}>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'subscriptions', label: 'Subscriptions' },
            { value: 'templates', label: 'Templates' },
          ]}
        />
      </View>
      {tab === 'subscriptions' ? <SubscriptionsTab pluginID={id} /> : <TemplatesTab />}
    </Screen>
  )
}
