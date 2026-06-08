import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import FileBrowser from '../index'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7' }), useRouter: () => ({ push: jest.fn() }), Stack: Object.assign(() => null, { Screen: () => null }) }))
jest.mock('@/api/files', () => ({ useDir: jest.fn() }))
import { useDir } from '@/api/files'

test('renders entries dirs-first and cd into a dir', () => {
  ;(useDir as jest.Mock).mockReturnValue({ data: [
    { name: 'file.txt', is_dir: false, size: 1, mode: 0, mtime: 0 },
    { name: 'sub', is_dir: true, size: 0, mode: 0, mtime: 0 },
  ], isLoading: false, isError: false, refetch: jest.fn(), isRefetching: false })
  const { getByText } = render(<FileBrowser />)
  expect(getByText('sub/')).toBeTruthy()
  expect(getByText('file.txt')).toBeTruthy()
  fireEvent.press(getByText('sub/'))
})
