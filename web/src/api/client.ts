export class APIError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type ApiOptions = {
  signal?: AbortSignal
  on401?: () => void
}

let on401Handler: () => void = () => {}
export function setOn401(fn: () => void) {
  on401Handler = fn
}

async function request<T>(method: string, path: string, body?: unknown, opts?: ApiOptions): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include',
    signal: opts?.signal,
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await fetch(path, init)
  if (res.status === 401) {
    on401Handler()
    throw new APIError(401, 'unauthorized')
  }
  if (res.status === 204) {
    return undefined as T
  }
  const text = await res.text()
  if (!res.ok) {
    let msg = res.statusText
    try {
      const j = text ? JSON.parse(text) : null
      if (j?.error) msg = j.error
    } catch {
      // ignore
    }
    throw new APIError(res.status, msg)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

// getText fetches a text/plain endpoint (e.g. a run's execution log) and
// returns the raw body without JSON-parsing it. Shares the auth/401
// handling of request() but skips the JSON.parse the typed helpers do.
async function getText(path: string, opts?: ApiOptions): Promise<string> {
  const res = await fetch(path, { method: 'GET', credentials: 'include', signal: opts?.signal })
  if (res.status === 401) {
    on401Handler()
    throw new APIError(401, 'unauthorized')
  }
  const text = await res.text()
  if (!res.ok) {
    throw new APIError(res.status, text || res.statusText)
  }
  return text
}

export const api = {
  get: <T>(path: string, opts?: ApiOptions) => request<T>('GET', path, undefined, opts),
  getText,
  post: <T>(path: string, body?: unknown, opts?: ApiOptions) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: ApiOptions) => request<T>('PUT', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: ApiOptions) => request<T>('PATCH', path, body, opts),
  delete: <T>(path: string, opts?: ApiOptions) => request<T>('DELETE', path, undefined, opts),
  del: <T>(path: string, opts?: ApiOptions) => request<T>('DELETE', path, undefined, opts),
}
