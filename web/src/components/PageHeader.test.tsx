import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from './PageHeader'

describe('PageHeader', () => {
  it('renders h1 title and actions', () => {
    render(<PageHeader title="Hosts" actions={<button>add</button>} />)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.textContent).toBe('Hosts')
    expect(h1.className).toContain('text-title')
    expect(screen.getByText('add')).toBeTruthy()
  })
})
