// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import { TimeSeriesChart } from './TimeSeriesChart'

beforeAll(() => {
  // jsdom does not implement ResizeObserver
  ;(window as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

describe('TimeSeriesChart', () => {
  it('mounts without throwing for a 2-point series', () => {
    const series = [{
      name: 'cpu',
      values: [
        { ts: '2026-01-01T00:00:00Z', v: 1 },
        { ts: '2026-01-01T00:01:00Z', v: 5 },
      ],
    }]
    const { container } = render(<TimeSeriesChart series={series} height={120} />)
    expect(container).toBeTruthy()
  })
})
