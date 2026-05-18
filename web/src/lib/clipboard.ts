// Copy text to the system clipboard. Tries the modern async Clipboard API
// first; falls back to the legacy execCommand path for non-secure contexts
// (plain HTTP) where navigator.clipboard is undefined.
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Permission denied or other transient failure — try legacy below.
    }
  }
  // Legacy fallback: a positioned, off-screen textarea + execCommand('copy').
  // Works in non-secure contexts and on browsers that block clipboard API.
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  try {
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('execCommand("copy") returned false')
  } finally {
    document.body.removeChild(ta)
  }
}
