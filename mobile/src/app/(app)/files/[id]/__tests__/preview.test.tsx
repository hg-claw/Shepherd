import React from 'react'
import { render, waitFor } from '@testing-library/react-native'
import Preview from '../preview'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7', path: '/a.txt' }), useRouter: () => ({ back: jest.fn() }) }))
jest.mock('@/api/files', () => ({ previewFile: jest.fn(), PREVIEW_MAX_BYTES: 65536 }))
import { previewFile } from '@/api/files'

test('renders text content', async () => {
  ;(previewFile as jest.Mock).mockResolvedValue({ kind: 'text', text: 'hello world' })
  const { getByText, queryByText } = render(<Preview />)
  await waitFor(() => expect(getByText('hello world')).toBeTruthy())
  expect(queryByText(/truncated/i)).toBeNull()
})
test('renders binary notice', async () => {
  ;(previewFile as jest.Mock).mockResolvedValue({ kind: 'binary' })
  const { getByText } = render(<Preview />)
  await waitFor(() => expect(getByText(/binary/i)).toBeTruthy())
})
test('shows a truncation banner when content hits the 64KB cap', async () => {
  ;(previewFile as jest.Mock).mockResolvedValue({ kind: 'text', text: 'x'.repeat(65536) })
  const { getByText } = render(<Preview />)
  await waitFor(() => expect(getByText(/truncated at 64\s?KB/i)).toBeTruthy())
})
