// Recover from stale-deploy chunk errors.
//
// When the server is redeployed while a tab is open, the running app's
// lazy import() still points at an old content-hashed chunk
// (e.g. AuditLogPage-DPwA4puQ.js) that the new build no longer emits, so
// the fetch 404s and the browser throws "Failed to fetch dynamically
// imported module". A full reload pulls the fresh index.html (served
// no-cache) and the new chunk names, fixing it.
//
// Guarded with sessionStorage so a genuinely-missing chunk or an offline
// network can't trap the tab in a reload loop: we reload at most once per
// RELOAD_WINDOW_MS.

const RELOAD_KEY = 'shepherd:chunk-reloaded-at'
const RELOAD_WINDOW_MS = 10_000

export function isChunkError(msg: string): boolean {
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(
    msg,
  )
}

function reloadOnce() {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  if (Date.now() - last < RELOAD_WINDOW_MS) {
    // Already reloaded recently and still failing — stop, don't loop.
    // The error surfaces normally so it's at least visible/loggable.
    return
  }
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  window.location.reload()
}

export function installChunkReload() {
  // Vite dispatches this when a preloaded lazy chunk fails to load.
  // preventDefault stops Vite from re-throwing after we've handled it.
  window.addEventListener('vite:preloadError', (e: Event) => {
    e.preventDefault()
    reloadOnce()
  })
  // Fallback for dynamic-import rejections that don't surface as
  // vite:preloadError (e.g. a React.lazy import() rejecting directly).
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason
    const msg = typeof reason === 'string' ? reason : (reason?.message ?? '')
    if (isChunkError(msg)) {
      reloadOnce()
    }
  })
}
