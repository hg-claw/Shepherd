import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

const STORAGE_KEY = 'shep_recent_hosts'
const MAX_RECENT = 4

function readStored(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v) => typeof v === 'number')
  } catch {
    return []
  }
}

// Track which servers the admin has opened. Triggered by URLs matching
// /admin/servers/<id>; mirrors the design's "visit-a-host" event. Cap at 4.
export function useRecentHosts(): number[] {
  const [ids, setIds] = useState<number[]>(() => readStored())
  const loc = useLocation()

  useEffect(() => {
    const m = loc.pathname.match(/^\/admin\/servers\/(\d+)(?:\/.*)?$/)
    if (!m) return
    const id = Number(m[1])
    if (!Number.isFinite(id)) return
    setIds((prev) => {
      if (prev[0] === id) return prev
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_RECENT)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage may be unavailable (private mode / quota); ignore
      }
      return next
    })
  }, [loc.pathname])

  return ids
}
