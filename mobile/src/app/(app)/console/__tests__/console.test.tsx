import React from 'react'
import { render, fireEvent, waitFor, act } from '@testing-library/react-native'
import ConsoleScreen from '../[id]'

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7' }), useRouter: () => ({ back: jest.fn() }) }))
// Capture the WebView's onMessage so tests can post bridge messages from "the WebView".
let webOnMessage: ((e: { nativeEvent: { data: string } }) => void) | undefined
jest.mock('react-native-webview', () => ({ WebView: (props: { onMessage?: (e: { nativeEvent: { data: string } }) => void }) => { webOnMessage = props.onMessage; return null } }))
const mockClipboard = jest.fn()
jest.mock('expo-clipboard', () => ({ setStringAsync: (s: string) => mockClipboard(s) }))
const postFromWeb = (o: unknown) => act(() => { webOnMessage?.({ nativeEvent: { data: JSON.stringify(o) } }) })
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

beforeEach(() => { mockWrite.mockReset(); mockCloses.length = 0; mockClipboard.mockReset(); webOnMessage = undefined })

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

test('open failure shows an error status and tapping the pill retries', async () => {
  ;(openConsole as jest.Mock).mockRejectedValueOnce(new Error('agent offline'))
  const { getByText, getByTestId, findByText } = render(<ConsoleScreen />)
  // open() threw → not stuck on 'connecting': explicit error + message in the strip
  expect(await findByText('agent offline')).toBeTruthy()
  expect(getByText(/error · tap to reconnect/)).toBeTruthy()
  expect(mockCloses.length).toBe(0) // no session was created
  const callsBefore = (openConsole as jest.Mock).mock.calls.length
  // tap the status pill to retry; the default mock now resolves
  fireEvent.press(getByTestId('status-pill'))
  await waitFor(() => expect((openConsole as jest.Mock).mock.calls.length).toBe(callsBefore + 1))
  await waitFor(() => expect(mockCloses.length).toBe(1)) // session created on retry
  expect(getByText('connecting')).toBeTruthy()
})

test('a long-press selecttext message opens the select-&-copy sheet with the text', async () => {
  const { getByTestId, queryByTestId } = render(<ConsoleScreen />)
  await waitFor(() => expect(openConsole).toHaveBeenCalled())
  expect(queryByTestId('select-text')).toBeNull() // sheet closed initially
  postFromWeb({ type: 'selecttext', text: 'line one\nline two' })
  expect(getByTestId('select-text').props.children).toBe('line one\nline two')
})

test('Copy all writes the selected text to the clipboard and closes the sheet', async () => {
  const { getByLabelText, queryByTestId } = render(<ConsoleScreen />)
  await waitFor(() => expect(openConsole).toHaveBeenCalled())
  postFromWeb({ type: 'selecttext', text: 'root@web-1:~#' })
  fireEvent.press(getByLabelText('Copy all'))
  expect(mockClipboard).toHaveBeenCalledWith('root@web-1:~#')
  await waitFor(() => expect(queryByTestId('select-text')).toBeNull()) // sheet closed
})
