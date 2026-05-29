import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import Wall from './Wall'
import { bps } from '@/lib/bytes'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const serverA = {
  id: 1,
  alias: 'alpha',
  group: 'EU',
  country_code: 'DE',
  online: true,
  platform: 'linux',
  arch: 'amd64',
  traffic_rx_bytes: 10 * 1024 * 1024 * 1024,
  traffic_tx_bytes: 5 * 1024 * 1024 * 1024,
  latest: {
    ts: new Date().toISOString(),
    cpu_pct: 45,
    mem_pct: 60,
    disks_pct: [30],
    net_rx_bps: 1_000_000,
    net_tx_bps: 500_000,
    load_1: 1.23,
    tcp_conn: 100,
  },
}

const serverB = {
  id: 2,
  alias: 'beta',
  group: 'US',
  country_code: 'US',
  online: false,
  platform: undefined,
  arch: undefined,
  traffic_rx_bytes: 0,
  traffic_tx_bytes: 0,
  latest: undefined,
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/api/public', () => ({
  usePublicServers: () => ({
    isLoading: false,
    error: null,
    data: [serverA, serverB],
  }),
}))

vi.mock('@/api/wallLive', () => ({
  useWallLiveNet: () => ({
    live: new Map([[serverA.id, { rx_bps: 999_000, tx_bps: 111_000 }]]),
    connected: true,
  }),
}))

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  // Silence missing i18n keys
  i18n.on('missingKey', () => {})
})

function renderPage() {
  const qc = new QueryClient()
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Wall />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Wall — public probe dashboard', () => {
  it('renders "Server status" heading', () => {
    renderPage()
    expect(screen.getByText('Server status')).toBeTruthy()
  })

  it('summary strip shows correct Nodes (2) and Online (1) counts', () => {
    renderPage()
    // SummaryStat renders: outer div > [icon span, inner div > [label div, value div]]
    // Walk up two levels from the label div to reach the outer card div.

    // Nodes card: label is exactly "Nodes" (unique on the page).
    const nodesLabel = screen.getByText('Nodes')
    const nodesCard = nodesLabel.parentElement?.parentElement
    expect(nodesCard).toBeTruthy()
    // The card's text content contains the value "2" and the label "Nodes".
    expect(nodesCard!.textContent).toContain('Nodes')
    expect(nodesCard!.textContent).toContain('2')

    // Online/Offline summary stats: the summary strip is the second div child
    // of the page root. Find an element whose full textContent is exactly the
    // online label (no slashes / digits) so we avoid hitting the group header.
    // The SummaryStat label div is a leaf with only the label text.
    const onlineStatLabel = screen.getAllByText((content, element) => {
      if (!element) return false
      // Must be a leaf-ish element (no children with text) whose own text
      // matches "online" case-insensitively and has no digits.
      return (
        /^online$/i.test(content.trim()) &&
        element.children.length === 0
      )
    })[0]
    expect(onlineStatLabel).toBeTruthy()
    const onlineCard = onlineStatLabel.parentElement?.parentElement
    expect(onlineCard).toBeTruthy()
    expect(onlineCard!.textContent).toContain('1')
  })

  it('renders serverA alias and platform in list view', () => {
    renderPage()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText((content) => content.includes('linux'))).toBeTruthy()
  })

  it('shows live net value (bps(999000)) in list view — live overrides polled', () => {
    renderPage()
    const liveRx = bps(999_000)
    // The live map overrides net_rx_bps=1_000_000 with rx_bps=999_000.
    // The value appears in both the SummaryStat strip (Realtime) and the table row.
    const matches = screen.getAllByText((content) => content.includes(liveRx))
    expect(matches.length).toBeGreaterThan(0)
  })

  it('group headers show X/Y online string', () => {
    renderPage()
    // EU group: 1 online / 1 total  → "1/1 online"
    expect(screen.getByText((content) => /1\/1/.test(content) && /online/.test(content))).toBeTruthy()
    // US group: 0 online / 1 total  → "0/1 online"
    expect(screen.getByText((content) => /0\/1/.test(content) && /online/.test(content))).toBeTruthy()
  })

  it('clicking the Grid toggle shows the grid container', () => {
    renderPage()
    // Find the Grid toggle button (contains LayoutGrid icon, label "Grid")
    const gridBtn = screen.getByText('Grid')
    fireEvent.click(gridBtn)
    // After switching to grid, WallServerCard renders the platform+arch line
    // "linux · amd64" is only visible in the grid card
    expect(screen.getByText('linux · amd64')).toBeTruthy()
  })
})
