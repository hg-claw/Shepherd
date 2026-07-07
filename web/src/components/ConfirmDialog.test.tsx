import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog'
import '@/i18n'

describe('ConfirmDialog', () => {
  it('fires onConfirm then closes', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete host"
        description="really?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    )
    expect(screen.getByText('really?')).toBeTruthy()
    fireEvent.click(screen.getByText('Delete'))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
