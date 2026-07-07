import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EmptyState } from './EmptyState'
import { LoadingState } from './LoadingState'
import { ErrorState } from './ErrorState'
import '@/i18n'

describe('state views', () => {
  it('EmptyState renders title, description and action', () => {
    render(<EmptyState title="No hosts" description="Add one" action={<button>add</button>} />)
    expect(screen.getByText('No hosts')).toBeTruthy()
    expect(screen.getByText('Add one')).toBeTruthy()
    expect(screen.getByText('add')).toBeTruthy()
  })
  it('LoadingState shows default loading copy', () => {
    const { container } = render(<LoadingState />)
    expect(container.textContent).not.toBe('')
    expect(container.querySelector('svg')).toBeTruthy()
  })
  it('ErrorState fires onRetry', () => {
    const onRetry = vi.fn()
    render(<ErrorState message="boom" onRetry={onRetry} />)
    expect(screen.getByText('boom')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
