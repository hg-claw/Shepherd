import { useMemo, useState } from 'react'

export type SortDir = 'asc' | 'desc'
export type SortState = { key: string; dir: SortDir } | null

export function useTableSort<T>(
  rows: T[],
  accessors: Record<string, (row: T) => string | number | null | undefined>,
  initial?: { key: string; dir: SortDir },
) {
  const [sort, setSort] = useState<SortState>(initial ?? null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const acc = accessors[sort.key]
    if (!acc) return rows
    const mul = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = acc(a)
      const bv = acc(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul
      return String(av).localeCompare(String(bv)) * mul
    })
  }, [rows, sort, accessors])

  const toggle = (key: string) =>
    setSort((s) => {
      if (s?.key !== key) return { key, dir: 'asc' }
      if (s.dir === 'asc') return { key, dir: 'desc' }
      return null
    })

  return { sorted, sort, toggle }
}
