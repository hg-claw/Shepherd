import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import NetqualityTargetNewScreen from '../nq-target-new'

const mockBack = jest.fn()
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

const mockCreate = jest.fn().mockResolvedValue({ ok: true })
jest.mock('@/api/netquality', () => ({
  createNetqualityTarget: (...a: unknown[]) => mockCreate(...a),
}))

beforeEach(() => { jest.clearAllMocks() })

test('Add is gated until both label and host are filled', () => {
  const { getByTestId } = render(<NetqualityTargetNewScreen />)
  fireEvent.press(getByTestId('target-submit'))
  expect(mockCreate).not.toHaveBeenCalled()
  fireEvent.changeText(getByTestId('label-input'), 'my-target')
  fireEvent.press(getByTestId('target-submit'))
  expect(mockCreate).not.toHaveBeenCalled() // host still empty
})

test('submits the trimmed body and omits an empty region, then returns', async () => {
  const { getByTestId } = render(<NetqualityTargetNewScreen />)
  fireEvent.changeText(getByTestId('label-input'), '  my-target  ')
  fireEvent.changeText(getByTestId('host-input'), ' 9.9.9.9 ')
  fireEvent.press(getByTestId('target-submit'))
  await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({
    isp: 'telecom', // default ISP
    region: undefined, // empty → omitted (server defaults to 'Custom')
    label: 'my-target',
    host: '9.9.9.9',
  }))
  await waitFor(() => expect(mockBack).toHaveBeenCalled())
})

test('a chosen ISP + region flow through to the body', async () => {
  const { getByText, getByTestId } = render(<NetqualityTargetNewScreen />)
  fireEvent.press(getByText('海外')) // overseas
  fireEvent.changeText(getByTestId('region-input'), 'US-West')
  fireEvent.changeText(getByTestId('label-input'), 'google-dns')
  fireEvent.changeText(getByTestId('host-input'), '8.8.8.8')
  fireEvent.press(getByTestId('target-submit'))
  await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({
    isp: 'overseas', region: 'US-West', label: 'google-dns', host: '8.8.8.8',
  }))
})

test('a create error surfaces inline and does not navigate away', async () => {
  mockCreate.mockRejectedValueOnce(new Error('label already exists'))
  const { getByTestId, findByText } = render(<NetqualityTargetNewScreen />)
  fireEvent.changeText(getByTestId('label-input'), 'dup')
  fireEvent.changeText(getByTestId('host-input'), '1.1.1.1')
  fireEvent.press(getByTestId('target-submit'))
  expect(await findByText('label already exists')).toBeTruthy()
  expect(mockBack).not.toHaveBeenCalled()
})
