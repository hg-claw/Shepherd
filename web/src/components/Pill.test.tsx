import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Pill } from './Pill'
import { statusStyles } from '@/lib/status'

describe('Pill', () => {
  it('uses shared statusStyles for ok kind', () => {
    const { container } = render(<Pill kind="ok">up</Pill>)
    const span = container.firstElementChild!
    expect(span.className).toContain(statusStyles.ok.bg)
    expect(span.className).toContain(statusStyles.ok.text)
  })
  it('neutral kind gets border', () => {
    const { container } = render(<Pill kind="neutral">idle</Pill>)
    expect(container.firstElementChild!.className).toContain('border-border')
  })
})
