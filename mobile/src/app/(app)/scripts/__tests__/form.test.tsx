import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import RunForm from '../[id]'
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '1', serverId: '7' }), useRouter: () => ({ push: mockPush }) }))
const mockRun = jest.fn().mockResolvedValue({ run_id: 9 })
jest.mock('@/api/scripts', () => ({
  useScripts: () => ({ data: [{ id: 1, name: 'deploy', params: [{ name: 'tag', required: true }] }] }),
  runScript: (...a: unknown[]) => mockRun(...a),
}))

beforeEach(() => { mockRun.mockClear(); mockPush.mockClear() })

test('Run is gated on required param, then calls runScript', async () => {
  const { getByText, getByPlaceholderText } = render(<RunForm />)
  fireEvent.press(getByText('Run'))
  expect(mockRun).not.toHaveBeenCalled()
  fireEvent.changeText(getByPlaceholderText('tag'), 'v1')
  fireEvent.press(getByText('Run'))
  await waitFor(() => expect(mockRun).toHaveBeenCalledWith(1, { tag: 'v1' }, 7))
})
