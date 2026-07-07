import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Server } from 'lucide-react'
import { StatCard } from './StatCard'

describe('StatCard', () => {
  it('kpi variant renders label, value and sub', () => {
    render(<StatCard label="Hosts" value={12} sub="3 offline" />)
    expect(screen.getByText('Hosts')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('3 offline')).toBeTruthy()
  })
  it('tone colours the value', () => {
    render(<StatCard label="Errors" value="3" tone="err" />)
    expect(screen.getByText('3').className).toContain('text-err')
  })
  it('compact variant renders the icon slot', () => {
    const { container } = render(
      <StatCard variant="compact" label="Nodes" value="8" icon={Server} />,
    )
    expect(container.querySelector('svg')).toBeTruthy()
  })
})
