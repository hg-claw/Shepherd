import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTableSort } from './useTableSort'

const rows = [
  { name: 'b', n: 2 },
  { name: 'a', n: null as number | null },
  { name: 'c', n: 1 },
]
const accessors = {
  name: (r: (typeof rows)[number]) => r.name,
  n: (r: (typeof rows)[number]) => r.n,
}

describe('useTableSort', () => {
  it('no sort returns rows as-is', () => {
    const { result } = renderHook(() => useTableSort(rows, accessors))
    expect(result.current.sorted).toEqual(rows)
  })
  it('toggle cycles asc -> desc -> off; nulls last', () => {
    const { result } = renderHook(() => useTableSort(rows, accessors))
    act(() => result.current.toggle('n'))
    expect(result.current.sorted.map((r) => r.name)).toEqual(['c', 'b', 'a'])
    act(() => result.current.toggle('n'))
    expect(result.current.sorted.map((r) => r.name)).toEqual(['b', 'c', 'a'])
    act(() => result.current.toggle('n'))
    expect(result.current.sort).toBeNull()
  })
})
