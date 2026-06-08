import React from 'react'
import { render } from '@testing-library/react-native'
import PluginDetail from '../index'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'xray' }), useRouter: () => ({ push: jest.fn() }) }))
jest.mock('@/api/plugins', () => ({
  usePlugins: () => ({ data: [{ id: 'xray', meta: { name: 'Xray', description: 'proxy', icon: '🛰', category: 'net', host_aware: true }, enabled: true, host_count: 3 }] }),
  enablePlugin: jest.fn(), disablePlugin: jest.fn(),
}))

test('renders meta and a Hosts row for host-aware plugins', () => {
  const { getByText } = render(<PluginDetail />)
  expect(getByText(/Xray/)).toBeTruthy()
  expect(getByText(/Hosts/)).toBeTruthy()
})
