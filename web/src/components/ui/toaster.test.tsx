// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { act } from 'react'
import { render, screen } from '@testing-library/react'
import { Toaster } from './toaster'
import { useUI } from '@/store/ui'

describe('Toaster (useUI source)', () => {
  beforeEach(() => { vi.useFakeTimers(); useUI.setState({ toasts: [] }) })
  afterEach(() => { vi.useRealTimers() })

  it('renders all rapid toasts (no limit-1 drop) and auto-dismisses', () => {
    render(<Toaster />)
    act(() => {
      useUI.getState().toast('info', 'alpha')
      useUI.getState().toast('error', 'bravo')
    })
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('bravo')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(6000) })
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.queryByText('bravo')).toBeNull()
  })
})
