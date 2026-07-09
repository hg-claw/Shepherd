import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useVirtualRows } from './useVirtualRows'

describe('useVirtualRows', () => {
  it('returns ref + items + paddings without crashing in jsdom', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }))
    const { result } = renderHook(() => useVirtualRows(rows))
    expect(result.current.parentRef).toBeTruthy()
    expect(result.current.padTop).toBeGreaterThanOrEqual(0)
    expect(result.current.padBottom).toBeGreaterThanOrEqual(0)
  })
})
