import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import PluginConfig from '../config'
const mockBack = jest.fn()
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'xray' }), useRouter: () => ({ back: mockBack }) }))
const mockSave = jest.fn().mockResolvedValue({ ok: true })
jest.mock('@/api/plugins', () => ({
  usePluginConfig: () => ({ data: { port: 443 }, isLoading: false, isError: false }),
  savePluginConfig: (...a: unknown[]) => mockSave(...a),
}))

beforeEach(() => { mockSave.mockClear(); mockBack.mockClear() })

test('invalid JSON blocks save; valid JSON saves the parsed object', async () => {
  const { getByText, getByTestId } = render(<PluginConfig />)
  fireEvent.changeText(getByTestId('config-input'), '{ not json')
  fireEvent.press(getByText('Save'))
  expect(mockSave).not.toHaveBeenCalled()
  expect(getByText(/Invalid JSON/)).toBeTruthy()
  fireEvent.changeText(getByTestId('config-input'), '{"port":8443}')
  fireEvent.press(getByText('Save'))
  await waitFor(() => expect(mockSave).toHaveBeenCalledWith('xray', { port: 8443 }))
})
