import React from 'react'
import { render } from '@testing-library/react-native'
import RunStatus from '../[runId]'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ runId: '9' }), useRouter: () => ({ back: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
jest.mock('@/api/scripts', () => ({ useRun: jest.fn() }))
import { useRun } from '@/api/scripts'

test('renders target status', () => {
  ;(useRun as jest.Mock).mockReturnValue({ data: [{ id: 1, server_id: 7, status: 'done', exit_code: 0 }], isLoading: false })
  const { getByText } = render(<RunStatus />)
  expect(getByText(/done/)).toBeTruthy()
})
