import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import ServerDetail from './ServerDetail'

const baseServer = {
  id: 1,
  name: 'test-server',
  public_alias: null,
  public_group: null,
  country_code: null,
  show_on_public: false,
  ssh_host: { Valid: true, String: '1.2.3.4' },
  ssh_port: 22,
  ssh_user: { Valid: true, String: 'root' },
  install_stage: 'done',
  install_log: '',
  install_error: null,
  install_started_at: null,
  agent_version: { Valid: true, String: 'v1.0.0' },
  agent_os: { Valid: true, String: 'linux' },
  agent_arch: { Valid: true, String: 'amd64' },
  agent_kernel: { Valid: true, String: '5.15.0' },
  agent_last_seen: { Valid: true, Time: new Date().toISOString() },
  agent_fingerprint: { Valid: false, String: '' },
  created_at: new Date().toISOString(),
  connected: true,
}

beforeAll(() => {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

// Shared mutable refs so individual tests can override per-hook data
let mockInventory: any = null
let mockTraffic: any = undefined

vi.mock('@/api/servers', () => ({
  useServer: () => ({ data: baseServer }),
  useTelemetry: () => ({ data: [] }),
  usePatchServer: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useDeleteServer: () => ({ mutateAsync: vi.fn() }),
  useRepair: () => ({ mutateAsync: vi.fn() }),
  usePushConfig: () => ({ mutateAsync: vi.fn() }),
  useServerIPCandidates: () => ({ data: [] }),
  useServerInstallCommand: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateAgent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useHostInventory: () => ({ data: mockInventory }),
  useHostTraffic: () => ({ data: mockTraffic }),
  useSetTrafficResetDay: () => ({ mutate: vi.fn() }),
  useResetTraffic: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/components/TimeSeriesChart', () => ({
  TimeSeriesChart: () => null,
}))

vi.mock('@/api/console', () => ({
  openConsole: vi.fn(),
}))

vi.mock('@/store/consoleTabs', () => ({
  useConsoleTabs: () => ({ open: vi.fn() }),
}))

vi.mock('@/store/ui', () => ({
  useUI: () => vi.fn(),
}))

function renderPage() {
  const qc = new QueryClient()
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/admin/servers/1']}>
          <Routes>
            <Route path="/admin/servers/:id" element={<ServerDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe('ServerDetail — Hardware card', () => {
  it('renders CPU, cpu_model and GPU name when inventory has one GPU', () => {
    mockInventory = {
      server_id: 1,
      cpu_physical: 8,
      cpu_logical: 16,
      cpu_model: 'Intel Core i9-13900K',
      mem_total: 32 * 1024 * 1024 * 1024,
      disk_total: 500 * 1024 * 1024 * 1024,
      gpus: [{ name: 'RTX 4090', vram_mib: 24576 }],
    }
    renderPage()
    expect(screen.getByText(/物理核/)).toBeTruthy()
    expect(screen.getByText(/Intel Core i9-13900K/)).toBeTruthy()
    expect(screen.getByText(/RTX 4090/)).toBeTruthy()
  })

  it('renders 无独立显卡 when gpus is empty', () => {
    mockInventory = {
      server_id: 1,
      cpu_physical: 4,
      cpu_logical: 8,
      cpu_model: 'AMD EPYC 7742',
      mem_total: 16 * 1024 * 1024 * 1024,
      disk_total: 256 * 1024 * 1024 * 1024,
      gpus: [],
    }
    renderPage()
    expect(screen.getByText('无独立显卡')).toBeTruthy()
  })

  it('renders — when inventory is null', () => {
    mockInventory = null
    renderPage()
    // Multiple '—' exist (KpiCard strip + Hardware card); find the one in a
    // <span class="text-muted-foreground"> which is how the Hardware card renders it.
    const dashes = screen.getAllByText('—')
    const muted = dashes.find((el) => el.tagName === 'SPAN' && el.className.includes('text-muted-foreground'))
    expect(muted).toBeTruthy()
  })
})

describe('ServerDetail — Traffic card', () => {
  it('renders 本周期 with formatted bytes and reset-day input when traffic data is present', () => {
    mockTraffic = {
      server_id: 1,
      cum_bytes_up: 1024 * 1024 * 1024,   // 1 GiB
      cum_bytes_down: 2 * 1024 * 1024 * 1024, // 2 GiB
      prev_bytes_up: 512 * 1024 * 1024,
      prev_bytes_down: 768 * 1024 * 1024,
      reset_day: 15,
      last_reset_at: null,
    }
    renderPage()
    expect(screen.getByText('本周期')).toBeTruthy()
    // bytes(1 GB) = "1.0 GB"; bytes(2 GB) = "2.0 GB"
    const row = screen.getByText((content) => content.includes('1.0 GB') && content.includes('2.0 GB'))
    expect(row).toBeTruthy()
    const input = screen.getByDisplayValue('15') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.type).toBe('number')
  })

  it('renders — when traffic data is undefined', () => {
    mockTraffic = undefined
    renderPage()
    // The traffic card renders a muted-foreground span with '—' when data absent
    const dashes = screen.getAllByText('—')
    const muted = dashes.find((el) => el.tagName === 'SPAN' && el.className.includes('text-muted-foreground'))
    expect(muted).toBeTruthy()
  })
})
