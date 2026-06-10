import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import * as Clipboard from 'expo-clipboard' // mocked in jest-setup.ts
import ServerNew from '../server-new'

const mockBack = jest.fn()
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))
const mockInstall = jest.fn()
jest.mock('@/api/install', () => ({ useScriptInstall: () => mockInstall }))

// Real wire shape from POST /api/servers/script (expires_at is RFC3339).
const WIRE = {
  server_id: 7,
  token: 'enroll-tok',
  expires_at: '2026-06-09T13:00:00Z',
  command: 'curl -fsSL https://shep.example.com/install.sh | bash -s -- --token enroll-tok',
}

beforeEach(() => {
  mockInstall.mockReset().mockResolvedValue(WIRE)
  ;(Clipboard.setStringAsync as jest.Mock).mockClear()
})

test('empty name never reaches the API — inline error instead', () => {
  const { getByText } = render(<ServerNew />)
  fireEvent.press(getByText('Generate install command'))
  expect(mockInstall).not.toHaveBeenCalled()
  expect(getByText('name required')).toBeTruthy()
})

test('generate sends the web-shaped payload and renders command + expiry + copy', async () => {
  const { getByText, getByPlaceholderText, getByTestId } = render(<ServerNew />)
  fireEvent.changeText(getByPlaceholderText('name'), 'edge-7')
  fireEvent.changeText(getByPlaceholderText('public group'), 'asia')
  fireEvent.changeText(getByPlaceholderText('US'), 'hk') // uppercased on input
  fireEvent.press(getByTestId('switch-public'))
  fireEvent.press(getByTestId('switch-cn'))
  fireEvent.press(getByText('Generate install command'))

  await waitFor(() => expect(getByText(WIRE.command)).toBeTruthy())
  expect(mockInstall).toHaveBeenCalledWith({
    name: 'edge-7',
    public_alias: undefined, // empty optionals are dropped, like the web form
    public_group: 'asia',
    country_code: 'HK',
    show_on_public: true,
    cn: true,
  })
  expect(getByText(/Token expires/)).toBeTruthy()
  expect(getByText(/2026-06-09T13:00:00Z/)).toBeTruthy()

  // Copy goes through the guarded expo-clipboard require (mocked in jest-setup).
  fireEvent.press(getByText('Copy'))
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(WIRE.command)
  expect(getByText('Copied')).toBeTruthy()
})

test('"Generate another command" returns to the form with values retained', async () => {
  const { getByText, getByPlaceholderText, getByDisplayValue } = render(<ServerNew />)
  fireEvent.changeText(getByPlaceholderText('name'), 'edge-7')
  fireEvent.press(getByText('Generate install command'))
  await waitFor(() => expect(getByText(WIRE.command)).toBeTruthy())

  fireEvent.press(getByText('Generate another command'))
  expect(getByText('Generate install command')).toBeTruthy()
  expect(getByDisplayValue('edge-7')).toBeTruthy() // form state survives

  // Re-issuing works: a second token comes back and renders.
  mockInstall.mockResolvedValue({ ...WIRE, token: 'tok2', command: 'curl ... tok2' })
  fireEvent.press(getByText('Generate install command'))
  await waitFor(() => expect(getByText('curl ... tok2')).toBeTruthy())
  expect(mockInstall).toHaveBeenCalledTimes(2)
})

test('API failure shows an inline error and keeps the form', async () => {
  mockInstall.mockRejectedValue(new Error('boom'))
  const { getByText, getByPlaceholderText } = render(<ServerNew />)
  fireEvent.changeText(getByPlaceholderText('name'), 'edge-7')
  fireEvent.press(getByText('Generate install command'))
  await waitFor(() => expect(getByText('boom')).toBeTruthy())
  expect(getByText('Generate install command')).toBeTruthy() // still on the form
})
