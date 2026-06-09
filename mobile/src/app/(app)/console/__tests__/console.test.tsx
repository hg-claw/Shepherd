import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import ConsoleScreen from '../[id]'

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7' }), useRouter: () => ({ back: jest.fn() }) }))
jest.mock('react-native-webview', () => ({ WebView: () => null }))
jest.mock('@/api/console', () => ({ openConsole: jest.fn().mockResolvedValue({ session_id: 1, sid: 's1' }) }))
jest.mock('@/store/auth', () => ({ useAuth: Object.assign((sel: any) => sel({ baseURL: 'https://h', token: 'T' }), { getState: () => ({ baseURL: 'https://h', token: 'T' }) }) }))
jest.mock('@/api/servers', () => ({ useServer: () => ({ id: 7, name: 'web-1', public_alias: { String: 'edge', Valid: true } }) }))

const mockWrite = jest.fn()
const mockCloses: jest.Mock[] = []
jest.mock('@/console/session', () => ({
  ConsoleSession: jest.fn().mockImplementation(() => {
    const close = jest.fn(); mockCloses.push(close)
    return { write: mockWrite, resize: jest.fn(), close }
  }),
}))
import { openConsole } from '@/api/console'

beforeEach(() => { mockWrite.mockReset(); mockCloses.length = 0 })

test('opens console on mount and a control key writes bytes', async () => {
  const { getByText } = render(<ConsoleScreen />)
  await waitFor(() => expect(openConsole).toHaveBeenCalledWith(7, expect.any(Number), expect.any(Number)))
  fireEvent.press(getByText('Esc'))
  expect(mockWrite).toHaveBeenCalled()
  expect(Array.from(mockWrite.mock.calls[0][0])).toEqual([0x1b])
})

test('reconnect closes the previous session', async () => {
  const { getByLabelText } = render(<ConsoleScreen />)
  await waitFor(() => expect(openConsole).toHaveBeenCalled())
  const firstClose = mockCloses[mockCloses.length - 1]
  fireEvent.press(getByLabelText('Reconnect'))
  await waitFor(() => expect(firstClose).toHaveBeenCalled())
})
