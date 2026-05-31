import { api } from './client'

// ── types ─────────────────────────────────────────────────────────────────────

export interface SubgenTemplate {
  id: number
  name: string
  builtin: boolean
  rules_json: string
}

export interface SubgenSubscription {
  id: number
  name: string
  token: string
  template_id: number
  enabled: boolean
}

export interface SubgenSelection {
  source: 'xray' | 'singbox'
  inbound_id: number
}


const BASE = '/api/admin/plugins/subgen'

// ── subscriptions ───────────────────────────────────────────────────────────────

export const listSubgenSubscriptions = (): Promise<SubgenSubscription[]> =>
  api.get<SubgenSubscription[]>(`${BASE}/subscriptions`)

export const createSubgenSubscription = (
  name: string,
  template_id: number,
): Promise<SubgenSubscription> =>
  api.post<SubgenSubscription>(`${BASE}/subscriptions`, { name, template_id })

export const updateSubgenSubscription = (
  id: number,
  body: { name?: string; template_id?: number; enabled?: boolean },
): Promise<SubgenSubscription> =>
  api.patch<SubgenSubscription>(`${BASE}/subscriptions/${id}`, body)

export const deleteSubgenSubscription = (id: number): Promise<void> =>
  api.del<void>(`${BASE}/subscriptions/${id}`)

export const rotateSubgenToken = (id: number): Promise<{ token: string }> =>
  api.post<{ token: string }>(`${BASE}/subscriptions/${id}/rotate-token`, {})

export const getSubgenInbounds = (id: number): Promise<SubgenSelection[]> =>
  api.get<SubgenSelection[]>(`${BASE}/subscriptions/${id}/inbounds`)

export const setSubgenInbounds = (
  id: number,
  inbounds: SubgenSelection[],
): Promise<void> =>
  api.put<void>(`${BASE}/subscriptions/${id}/inbounds`, { inbounds })

// ── templates ─────────────────────────────────────────────────────────────────

export const listSubgenTemplates = (): Promise<SubgenTemplate[]> =>
  api.get<SubgenTemplate[]>(`${BASE}/templates`)

export const createSubgenTemplate = (
  name: string,
  rules_json: string,
): Promise<SubgenTemplate> =>
  api.post<SubgenTemplate>(`${BASE}/templates`, { name, rules_json })

export const updateSubgenTemplate = (
  id: number,
  name: string,
  rules_json: string,
): Promise<SubgenTemplate> =>
  api.patch<SubgenTemplate>(`${BASE}/templates/${id}`, { name, rules_json })

export const deleteSubgenTemplate = (id: number): Promise<void> =>
  api.del<void>(`${BASE}/templates/${id}`)

// previewSubgenTemplate renders unsaved rules_json against sample nodes and
// returns the raw config text for the given target (surge|shadowrocket).
export const previewSubgenTemplate = (
  rules_json: string,
  target: string,
  opts?: { signal?: AbortSignal },
): Promise<string> =>
  api.postText(`${BASE}/templates/preview`, { rules_json, target }, opts)

// listSubgenOixGroups returns the ordered selectable oixCloud service-group names.
export const listSubgenOixGroups = (): Promise<string[]> =>
  api.get<string[]>(`${BASE}/oix-groups`)
