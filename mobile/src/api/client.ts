export class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'APIError'
  }
}

export async function apiFetch<T>(
  baseURL: string,
  token: string | null,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${baseURL}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  if (!res.ok) {
    const msg = (parsed as { error?: string } | null)?.error ?? `request failed (${res.status})`
    throw new APIError(res.status, msg)
  }
  return parsed as T
}
