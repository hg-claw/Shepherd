import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline } from './Sparkline'

describe('Sparkline', () => {
  it('renders empty svg with <2 points', () => {
    const { container } = render(<Sparkline values={[5]} />)
    expect(container.querySelector('polyline')).toBeNull()
  })
  it('renders polyline with 2+ points', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} />)
    const poly = container.querySelector('polyline')
    expect(poly).not.toBeNull()
    expect(poly?.getAttribute('points')?.split(' ').length).toBe(3)
  })
})
