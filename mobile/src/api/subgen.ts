import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

// Subscription generator (subgen) plugin API client.
//
// Wire shapes mirror the Go handlers under internal/plugins/subgen/routes.go.
// IMPORTANT: every subgen *View* struct (subscriptionView / templateView /
// Selection) is a PLAIN VALUE — there are NO sql.Null* objects on these
// endpoints, so nothing here goes through nullStr(). (sql.Null* lives only in
// the un-serialized collect.go rows; node-tag resolution via listProxyInbounds
// still carries NullStr and stays in api/metrics.ts.)

// subscriptionView: id/name/token/template_id/enabled — token is the PUBLIC
// secret the client imports via /sub/{token}.
export type Subscription = {
  id: number
  name: string
  token: string
  template_id: number
  enabled: boolean
}

// templateView: rules_json is a STRING of JSON (opaque here — authoring the
// rules body is deferred to web). builtin templates are read-only (403 on
// edit/delete).
export type Template = {
  id: number
  name: string
  builtin: boolean
  rules_json: string
}

// Selection keys a bundled node by its source plugin + inbound id. The /inbounds
// endpoint always returns [] (never null). De-dupe on `${source}:${inbound_id}`.
export type Selection = {
  source: 'xray' | 'singbox'
  inbound_id: number
}

// Renderer targets. surge/shadowrocket/clash match the web target selector;
// the renderer also accepts quantumultx (kept for parity). 400 = bad target.
export type SubTarget = 'surge' | 'shadowrocket' | 'clash' | 'quantumultx'
export const SUB_TARGETS: SubTarget[] = ['surge', 'shadowrocket', 'clash', 'quantumultx']

const BASE = '/api/admin/plugins/subgen'

// ── subscriptions ─────────────────────────────────────────────────────────────

export function listSubscriptions(): Promise<Subscription[]> {
  return authedFetch<Subscription[]>(`${BASE}/subscriptions`)
}

export function useSubscriptions(): UseQueryResult<Subscription[]> {
  return useQuery({ queryKey: ['subgen-subscriptions'], queryFn: listSubscriptions })
}

// Create lets the server mint the token; only name + template_id are sent (name
// required → 400 when blank).
export function createSubscription(body: { name: string; template_id: number }): Promise<Subscription> {
  return authedFetch<Subscription>(`${BASE}/subscriptions`, { method: 'POST', body })
}

// PATCH TRAP: updateSubscriptionBody is plain non-pointer Name/TemplateID/Enabled,
// so the Go side zero-fills any omitted field (an enabled-only body would blank
// the name and zero the template_id). Callers MUST send the FULL triple from the
// current row.
export function updateSubscription(
  id: number,
  body: { name: string; template_id: number; enabled: boolean },
): Promise<Subscription> {
  return authedFetch<Subscription>(`${BASE}/subscriptions/${id}`, { method: 'PATCH', body })
}

export function deleteSubscription(id: number): Promise<unknown> {
  return authedFetch<unknown>(`${BASE}/subscriptions/${id}`, { method: 'DELETE' })
}

// rotate-token mints a NEW public token (empty body) and returns it.
export function rotateToken(id: number): Promise<{ token: string }> {
  return authedFetch<{ token: string }>(`${BASE}/subscriptions/${id}/rotate-token`, { method: 'POST' })
}

// Bundled-node selection (read-only on mobile; the grouped multi-select picker
// and PUT replace stay on web). Server coerces to [] so this is never null.
export function listSubscriptionInbounds(id: number): Promise<Selection[]> {
  return authedFetch<Selection[]>(`${BASE}/subscriptions/${id}/inbounds`)
}

export function useSubscriptionInbounds(id: number | null): UseQueryResult<Selection[]> {
  return useQuery({
    queryKey: ['subgen-sub-inbounds', id],
    queryFn: () => listSubscriptionInbounds(id as number),
    enabled: id != null,
  })
}

// ── templates ─────────────────────────────────────────────────────────────────

export function listTemplates(): Promise<Template[]> {
  return authedFetch<Template[]>(`${BASE}/templates`)
}

export function useTemplates(): UseQueryResult<Template[]> {
  return useQuery({ queryKey: ['subgen-templates'], queryFn: listTemplates })
}

// Delete a CUSTOM template. Built-ins are protected server-side (403); only the
// delete-custom path is exposed on mobile (authoring/editing the rules body is
// deferred to web).
export function deleteTemplate(id: number): Promise<unknown> {
  return authedFetch<unknown>(`${BASE}/templates/${id}`, { method: 'DELETE' })
}

// ── public /sub URL ────────────────────────────────────────────────────────────

// buildSubURL assembles the PUBLIC import URL a client points its app at. It
// lives on the ROOT mux (router.go) at /sub/{token}, NOT under /api/admin, and
// carries no bearer — the token IS the secret. RN has no location.origin, so the
// origin is the auth-store baseURL. Returns '' when the baseURL is unknown.
export function buildSubURL(baseURL: string | null | undefined, token: string, target: SubTarget): string {
  if (!baseURL) return ''
  const origin = baseURL.replace(/\/+$/, '')
  return `${origin}/sub/${encodeURIComponent(token)}?target=${target}`
}
