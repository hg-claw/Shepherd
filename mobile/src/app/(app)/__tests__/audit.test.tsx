import React from 'react'
import { ActivityIndicator } from 'react-native'
import { render, fireEvent } from '@testing-library/react-native'
import AuditLog from '../audit'

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))
jest.mock('@/api/audit', () => ({ useAuditLog: jest.fn() }))
jest.mock('@/api/servers', () => ({ useServers: jest.fn() }))
import { useAuditLog } from '@/api/audit'
import { useServers } from '@/api/servers'

// Real wire shapes: public_alias is a Go sql.NullString ({String, Valid}).
const SERVERS = [
  { id: 7, name: 'srv-fra-1', connected: true, latest: null, public_alias: { String: 'frankfurt', Valid: true } },
  { id: 8, name: 'srv-sgp-1', connected: false, latest: null, public_alias: { String: '', Valid: false } },
]

const ROWS = [
  { id: 101, ts: '2026-06-09T00:00:00Z', admin_id: 1, server_id: 7, action: 'server.deploy', details: '{"plugin":"caddy","version":"2.8"}', result: 'ok' as const },
  { id: 102, ts: '2026-06-09T00:01:00Z', admin_id: 1, server_id: 8, action: 'script.run', details: '{"script":"reboot"}', result: 'error' as const },
  { id: 103, ts: '2026-06-09T00:02:00Z', admin_id: 1, server_id: 99, action: 'server.delete', details: '{}', result: 'ok' as const },
  { id: 104, ts: '2026-06-09T00:03:00Z', admin_id: 1, server_id: null, action: 'login', details: '', result: 'ok' as const },
]

const okQuery = (data: unknown) => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() })

beforeEach(() => {
  ;(useServers as jest.Mock).mockReturnValue(okQuery(SERVERS))
})

test('shows a spinner while loading', () => {
  ;(useAuditLog as jest.Mock).mockReturnValue({ data: undefined, isLoading: true, isError: false, isRefetching: false, refetch: jest.fn() })
  const { queryByText, UNSAFE_queryByType } = render(<AuditLog />)
  expect(UNSAFE_queryByType(ActivityIndicator)).toBeTruthy()
  expect(queryByText('server.deploy')).toBeNull()
})

test('shows error state with retry', () => {
  const refetch = jest.fn()
  ;(useAuditLog as jest.Mock).mockReturnValue({ data: undefined, isLoading: false, isError: true, isRefetching: false, refetch })
  const { getByText } = render(<AuditLog />)
  getByText('Failed to load the audit log.')
  fireEvent.press(getByText('Retry'))
  expect(refetch).toHaveBeenCalled()
})

test('renders rows with result tone and server alias join', () => {
  ;(useAuditLog as jest.Mock).mockReturnValue(okQuery(ROWS))
  const { getByText, getAllByText, getByTestId, queryByText } = render(<AuditLog />)
  // result pills (ok appears on three rows)
  expect(getAllByText('ok').length).toBe(3)
  getByText('error')
  // alias join: NullString alias wins; invalid alias falls back to server name;
  // unknown id falls back to '#id'; null server_id renders no server label.
  getByText('frankfurt')
  getByText('srv-sgp-1')
  getByText('#99')
  getByTestId('audit-row-104') // the null-server_id row still renders
  expect(queryByText('#104')).toBeNull()
})

test('action filter chips narrow the list', () => {
  ;(useAuditLog as jest.Mock).mockReturnValue(okQuery(ROWS))
  const { getByText, getByTestId, queryByTestId, getAllByText } = render(<AuditLog />)
  // 'script.run' appears as both a chip and a row text; press the chip (rendered first).
  fireEvent.press(getAllByText('script.run')[0])
  expect(queryByTestId('audit-row-101')).toBeNull() // server.deploy
  expect(queryByTestId('audit-row-103')).toBeNull() // server.delete
  getByTestId('audit-row-102') // the script.run row stays
  // 'all' resets the filter
  fireEvent.press(getByText('all'))
  getByTestId('audit-row-101')
})

test('tapping a row expands its details', () => {
  ;(useAuditLog as jest.Mock).mockReturnValue(okQuery(ROWS))
  const { getByTestId } = render(<AuditLog />)
  expect(getByTestId('audit-details-101').props.numberOfLines).toBe(1)
  fireEvent.press(getByTestId('audit-row-101'))
  expect(getByTestId('audit-details-101').props.numberOfLines).toBeUndefined()
  expect(getByTestId('audit-details-101').props.children).toBe('{"plugin":"caddy","version":"2.8"}')
  // collapses again on the second tap
  fireEvent.press(getByTestId('audit-row-101'))
  expect(getByTestId('audit-details-101').props.numberOfLines).toBe(1)
})
