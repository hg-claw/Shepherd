import React from 'react'
import { render } from '@testing-library/react-native'
import ScriptsList from '../index'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ serverId: '7' }), useRouter: () => ({ push: jest.fn(), back: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
jest.mock('@/api/scripts', () => ({ useScripts: jest.fn() }))
import { useScripts } from '@/api/scripts'

test('renders scripts', () => {
  ;(useScripts as jest.Mock).mockReturnValue({ data: [{ id: 1, name: 'deploy', description: 'd', params: [] }], isLoading: false, isError: false })
  const { getByText } = render(<ScriptsList />)
  expect(getByText('deploy')).toBeTruthy()
})
