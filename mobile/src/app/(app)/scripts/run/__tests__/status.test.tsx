import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import RunStatus from '../[runId]'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ runId: '9' }), useRouter: () => ({ back: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
jest.mock('@/api/scripts', () => ({
  useRun: jest.fn(),
  useTargetLog: jest.fn(),
  isTerminalStatus: (s: string) => ['done', 'success', 'failed', 'error', 'timeout', 'cancelled'].includes(s),
}))
jest.mock('@/api/servers', () => ({ useServers: jest.fn() }))
import { useRun, useTargetLog } from '@/api/scripts'
import { useServers } from '@/api/servers'

// Wire-shaped fixture: public_alias is a Go sql.NullString ({String, Valid}).
const SERVERS = [
  { id: 7, name: 'srv-7', public_alias: { String: 'alpha', Valid: true }, connected: true, latest: null },
]

beforeEach(() => {
  ;(useServers as jest.Mock).mockReturnValue({ data: SERVERS })
  ;(useTargetLog as jest.Mock).mockReset().mockReturnValue({ data: undefined, isLoading: false, isError: false })
})

test('renders target status with the server alias (joined from useServers)', () => {
  ;(useRun as jest.Mock).mockReturnValue({
    data: [{ id: 1, server_id: 7, status: 'done', exit_code: 0, pty_session_id: 5 }],
    isLoading: false, refetch: jest.fn(),
  })
  const { getByText } = render(<RunStatus />)
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText(/done/)).toBeTruthy()
})

test('falls back to #id when the server is not in the cached list', () => {
  ;(useRun as jest.Mock).mockReturnValue({
    data: [{ id: 1, server_id: 12, status: 'running', pty_session_id: null }],
    isLoading: false, refetch: jest.fn(),
  })
  const { getByText, queryByText } = render(<RunStatus />)
  expect(getByText('#12')).toBeTruthy()
  // footer must not claim streaming; it polls
  expect(getByText('auto-refreshing every 2s')).toBeTruthy()
  expect(queryByText(/streaming/)).toBeNull()
})

test('expanding a running target polls the log every 2s and shows the text', () => {
  ;(useRun as jest.Mock).mockReturnValue({
    data: [{ id: 1, server_id: 7, status: 'running', pty_session_id: 5 }],
    isLoading: false, refetch: jest.fn(),
  })
  ;(useTargetLog as jest.Mock).mockReturnValue({ data: 'step 1 ok\nstep 2…', isLoading: false, isError: false })
  const { getByText } = render(<RunStatus />)
  expect(useTargetLog).not.toHaveBeenCalled() // collapsed → log component not mounted
  fireEvent.press(getByText('view log'))
  expect(useTargetLog).toHaveBeenCalledWith(5, 2000) // running → 2s polling
  expect(getByText(/step 1 ok/)).toBeTruthy()
})

test('a finished target fetches the log once (no polling interval)', () => {
  ;(useRun as jest.Mock).mockReturnValue({
    data: [{ id: 1, server_id: 7, status: 'done', exit_code: 0, pty_session_id: 5 }],
    isLoading: false, refetch: jest.fn(),
  })
  ;(useTargetLog as jest.Mock).mockReturnValue({ data: 'all done', isLoading: false, isError: false })
  const { getByText } = render(<RunStatus />)
  fireEvent.press(getByText('view log'))
  expect(useTargetLog).toHaveBeenCalledWith(5, undefined)
  expect(getByText('all done')).toBeTruthy()
  expect(getByText('run complete · pull to refresh')).toBeTruthy()
})

test('handles a target without pty_session_id gracefully', () => {
  ;(useRun as jest.Mock).mockReturnValue({
    data: [{ id: 1, server_id: 7, status: 'queued' }],
    isLoading: false, refetch: jest.fn(),
  })
  const { getByText } = render(<RunStatus />)
  fireEvent.press(getByText('view log'))
  expect(getByText('log not available')).toBeTruthy()
  // the hook must not be asked to fetch a bogus id
  expect(useTargetLog).toHaveBeenCalledWith(null, 2000)
})
