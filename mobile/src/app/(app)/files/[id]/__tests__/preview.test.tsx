import React from 'react'
import { render, waitFor } from '@testing-library/react-native'
import Preview from '../preview'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7', path: '/a.txt' }), Stack: Object.assign(() => null, { Screen: () => null }) }))
jest.mock('@/api/files', () => ({ previewFile: jest.fn() }))
import { previewFile } from '@/api/files'

test('renders text content', async () => {
  ;(previewFile as jest.Mock).mockResolvedValue({ kind: 'text', text: 'hello world' })
  const { getByText } = render(<Preview />)
  await waitFor(() => expect(getByText('hello world')).toBeTruthy())
})
test('renders binary notice', async () => {
  ;(previewFile as jest.Mock).mockResolvedValue({ kind: 'binary' })
  const { getByText } = render(<Preview />)
  await waitFor(() => expect(getByText(/binary/i)).toBeTruthy())
})
