import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import NetqualityHistoryScreen, {
  fmtRTT, fmtLoss, avgRTT, avgLoss, rttSeries, lossSeries,
} from '../nq-history'
import type { NetqualitySamplePoint } from '@/api/netquality'

const mockBack = jest.fn()
const mockParams = jest.fn<Record<string, string | undefined>, []>(
  () => ({ id: 'netquality', serverId: '7', targetId: '1', label: '电信上海' }),
)
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams(),
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

type Q = { data?: unknown; isLoading: boolean; isError: boolean; isRefetching: boolean; refetch: jest.Mock }
const ok = (data: unknown): Q => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() })
const loading: Q = { data: undefined, isLoading: true, isError: false, isRefetching: false, refetch: jest.fn() }
const failed: Q = { data: undefined, isLoading: false, isError: true, isRefetching: false, refetch: jest.fn() }

const mockSamples = jest.fn<Q, []>()
jest.mock('@/api/netquality', () => ({
  ...jest.requireActual('@/api/netquality'),
  useNetqualitySamples: () => mockSamples(),
}))

const POINTS: NetqualitySamplePoint[] = [
  { ts: '2026-06-09T01:00:00Z', rtt_avg_ms: 40, loss_pct: 0, status: 'ok' },
  { ts: '2026-06-09T01:05:00Z', rtt_avg_ms: null, loss_pct: 100, status: 'lost' }, // lost: excluded from avg RTT
  { ts: '2026-06-09T01:10:00Z', rtt_avg_ms: 60, loss_pct: 50, status: 'ok' },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockParams.mockReturnValue({ id: 'netquality', serverId: '7', targetId: '1', label: '电信上海' })
  mockSamples.mockReturnValue(ok({ resolution: 'raw', points: POINTS }))
})

// ── pure helpers ──────────────────────────────────────────────────────────────

test('fmtRTT / fmtLoss render without Intl and tolerate null', () => {
  expect(fmtRTT(41.23)).toBe('41.2 ms')
  expect(fmtRTT(null)).toBe('—')
  expect(fmtLoss(2.5)).toBe('2.5%')
  expect(fmtLoss(undefined)).toBe('—')
})

test('avgRTT averages only successful buckets (null rtt excluded)', () => {
  expect(avgRTT(POINTS)).toBe(50) // (40 + 60) / 2, the null bucket dropped
  expect(avgRTT([])).toBeNull()
  expect(avgRTT([{ ts: 'x', rtt_avg_ms: null, loss_pct: 100 }])).toBeNull()
})

test('avgLoss averages every bucket (null loss → 0)', () => {
  expect(avgLoss(POINTS)).toBe(50) // (0 + 100 + 50) / 3
  expect(avgLoss([])).toBeNull()
})

test('rttSeries / lossSeries map to {x,y} with time x and null gaps', () => {
  const r = rttSeries(POINTS)
  expect(r).toHaveLength(3)
  expect(r[0]).toEqual({ x: new Date('2026-06-09T01:00:00Z').getTime(), y: 40 })
  expect(r[1].y).toBeNull() // lost bucket → gap
  expect(lossSeries(POINTS)[1]).toEqual({ x: new Date('2026-06-09T01:05:00Z').getTime(), y: 100 })
})

// ── screen ──────────────────────────────────────────────────────────────────

test('renders the label as the title and both RTT/loss charts with KPIs', () => {
  const { getByText, getByTestId } = render(<NetqualityHistoryScreen />)
  expect(getByText('电信上海')).toBeTruthy() // NavBar title from label param
  expect(getByText('50.0 ms')).toBeTruthy() // avg rtt KPI
  expect(getByText('50.0%')).toBeTruthy()   // avg loss KPI
  expect(getByTestId('history-rtt')).toBeTruthy()
  expect(getByTestId('history-loss')).toBeTruthy()
})

test('1h/24h range segmented toggles', () => {
  const { getByText } = render(<NetqualityHistoryScreen />)
  fireEvent.press(getByText('24h'))
  expect(mockSamples).toHaveBeenCalled() // re-renders with the new range
})

test('loading shows a spinner', () => {
  mockSamples.mockReturnValue(loading)
  expect(render(<NetqualityHistoryScreen />).getByTestId('history-loading')).toBeTruthy()
})

test('error offers retry', () => {
  const fq = { ...failed, refetch: jest.fn() }
  mockSamples.mockReturnValue(fq)
  const { getByText } = render(<NetqualityHistoryScreen />)
  fireEvent.press(getByText('Retry'))
  expect(fq.refetch).toHaveBeenCalled()
})

test('empty range explains the wait', () => {
  mockSamples.mockReturnValue(ok({ resolution: 'raw', points: [] }))
  const { getByText } = render(<NetqualityHistoryScreen />)
  expect(getByText('No samples in this range yet.')).toBeTruthy()
})

test('a missing target id shows an empty state', () => {
  mockParams.mockReturnValue({ id: 'netquality', serverId: '7' }) // no targetId
  const { getByText } = render(<NetqualityHistoryScreen />)
  expect(getByText('No target selected.')).toBeTruthy()
})
