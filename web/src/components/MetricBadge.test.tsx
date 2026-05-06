import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test-utils/render'
import { MetricBadge } from './MetricBadge'

describe('MetricBadge', () => {
  it('renders raw percentage', () => {
    const { getByText } = renderWithProviders(
      <MetricBadge metric="cpu" mode="raw" kind="pct" value={42} />,
    )
    expect(getByText('42%')).toBeInTheDocument()
  })

  it('renders level label', () => {
    const { container } = renderWithProviders(
      <MetricBadge metric="cpu" mode="level" kind="pct" value={95} />,
    )
    expect(container.textContent).toContain('告警')
  })

  it('both mode shows raw + level', () => {
    const { container } = renderWithProviders(
      <MetricBadge metric="cpu" mode="both" kind="pct" value={50} />,
    )
    expect(container.textContent).toContain('50%')
  })

  it('null value renders dash in raw mode', () => {
    const { getByText } = renderWithProviders(
      <MetricBadge metric="cpu" mode="raw" kind="pct" value={null} />,
    )
    expect(getByText('-')).toBeInTheDocument()
  })
})
