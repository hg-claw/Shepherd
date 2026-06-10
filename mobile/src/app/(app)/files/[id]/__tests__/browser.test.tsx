import React from 'react'
import { render, fireEvent, waitFor, act } from '@testing-library/react-native'
import { Alert } from 'react-native'
import FileBrowser from '../index'

const mockAddListener = jest.fn(() => jest.fn())
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '7' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useNavigation: () => ({ addListener: mockAddListener }),
}))
jest.mock('@/api/files', () => ({ useDir: jest.fn(), mkdir: jest.fn(), renamePath: jest.fn(), rmPath: jest.fn() }))
jest.mock('@/api/servers', () => ({ useServer: () => undefined }))
import { useDir, mkdir, renamePath, rmPath } from '@/api/files'

type Ent = { name: string; is_dir: boolean; size: number; mode: number; mtime: number }
const fileEnt = (name: string, size = 0): Ent => ({ name, is_dir: false, size, mode: 0, mtime: 0 })
const dirEnt = (name: string): Ent => ({ name, is_dir: true, size: 0, mode: 0, mtime: 0 })
const dirData = (entries: Ent[]) => ({
  data: entries, isLoading: false, isError: false, isRefetching: false,
  refetch: jest.fn().mockResolvedValue(undefined),
})

let alertSpy: jest.SpyInstance
beforeEach(() => {
  jest.clearAllMocks()
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
})

type AlertBtn = { text?: string; onPress?: () => void }
const alertButtons = (call: number): AlertBtn[] => (alertSpy.mock.calls[call]?.[2] ?? []) as AlertBtn[]
const pressAlertButton = (call: number, text: string) => {
  const btn = alertButtons(call).find((b) => b.text === text)
  expect(btn).toBeTruthy()
  act(() => btn!.onPress?.())
}

test('renders entries dirs-first with humanized sizes and audit caption', () => {
  ;(useDir as jest.Mock).mockReturnValue(dirData([fileEnt('file.txt', 2048), dirEnt('sub')]))
  const { getByText, queryByText } = render(<FileBrowser />)
  expect(getByText('sub/')).toBeTruthy()
  expect(getByText('file.txt')).toBeTruthy()
  expect(getByText('2.0 KB')).toBeTruthy()
  expect(getByText('audit-logged')).toBeTruthy()
  expect(queryByText(/read-only/i)).toBeNull()
})

test('cd into an empty dir shows .. and an empty state', () => {
  ;(useDir as jest.Mock).mockImplementation((_sid: number, path: string) =>
    dirData(path === '/' ? [dirEnt('sub')] : []))
  const { getByText } = render(<FileBrowser />)
  fireEvent.press(getByText('sub/'))
  expect(getByText('..')).toBeTruthy()
  expect(getByText('Empty directory.')).toBeTruthy()
})

test('hardware back navigates up a level instead of popping, and passes through at root', () => {
  ;(useDir as jest.Mock).mockImplementation((_sid: number, path: string) =>
    dirData(path === '/' ? [dirEnt('sub')] : []))
  const { getByText } = render(<FileBrowser />)
  fireEvent.press(getByText('sub/'))
  expect(getByText('Empty directory.')).toBeTruthy()

  // Listener registered for path=/sub intercepts and goes up.
  const calls = mockAddListener.mock.calls as unknown as [string, (e: { preventDefault: () => void }) => void][]
  expect(calls.every(([ev]) => ev === 'beforeRemove')).toBe(true)
  const cb = calls[calls.length - 1][1]
  const evt = { preventDefault: jest.fn() }
  act(() => cb(evt))
  expect(evt.preventDefault).toHaveBeenCalled()
  expect(getByText('sub/')).toBeTruthy() // back at /

  // At root the listener lets the pop happen.
  const calls2 = mockAddListener.mock.calls as unknown as [string, (e: { preventDefault: () => void }) => void][]
  const cb2 = calls2[calls2.length - 1][1]
  const evt2 = { preventDefault: jest.fn() }
  act(() => cb2(evt2))
  expect(evt2.preventDefault).not.toHaveBeenCalled()
})

test('breadcrumb root segment is a button that jumps back to /', () => {
  ;(useDir as jest.Mock).mockImplementation((_sid: number, path: string) =>
    dirData(path === '/' ? [dirEnt('sub')] : []))
  const { getByText, getByLabelText } = render(<FileBrowser />)
  fireEvent.press(getByText('sub/'))
  fireEvent.press(getByLabelText('Go to /'))
  expect(getByText('sub/')).toBeTruthy()
})

test('new-folder flow: prompt, mkdir, refresh', async () => {
  const d = dirData([dirEnt('sub')])
  ;(useDir as jest.Mock).mockReturnValue(d)
  ;(mkdir as jest.Mock).mockResolvedValue({ ok: true })
  const { getByLabelText, getByPlaceholderText, getByText } = render(<FileBrowser />)
  fireEvent.press(getByLabelText('New folder'))
  fireEvent.changeText(getByPlaceholderText('new folder name'), 'logs')
  fireEvent.press(getByText('Create'))
  await waitFor(() => expect(mkdir).toHaveBeenCalledWith(7, '/logs'))
  await waitFor(() => expect(d.refetch).toHaveBeenCalled())
})

test('mkdir failure shows an inline error and keeps the form open', async () => {
  ;(useDir as jest.Mock).mockReturnValue(dirData([dirEnt('sub')]))
  ;(mkdir as jest.Mock).mockRejectedValue(new Error('mkdir: permission denied'))
  const { getByLabelText, getByPlaceholderText, getByText } = render(<FileBrowser />)
  fireEvent.press(getByLabelText('New folder'))
  fireEvent.changeText(getByPlaceholderText('new folder name'), 'logs')
  fireEvent.press(getByText('Create'))
  await waitFor(() => expect(getByText('mkdir: permission denied')).toBeTruthy())
  expect(getByPlaceholderText('new folder name')).toBeTruthy()
})

test('rename flow: row actions -> prefilled input -> rename + refresh', async () => {
  const d = dirData([fileEnt('a.txt', 1)])
  ;(useDir as jest.Mock).mockReturnValue(d)
  ;(renamePath as jest.Mock).mockResolvedValue({ ok: true })
  const { getByLabelText, getByDisplayValue, getByText } = render(<FileBrowser />)
  fireEvent.press(getByLabelText('Actions for a.txt'))
  expect(alertSpy.mock.calls[0][0]).toBe('a.txt')
  pressAlertButton(0, 'Rename')
  const input = getByDisplayValue('a.txt')
  fireEvent.changeText(input, 'b.txt')
  fireEvent.press(getByText('Rename'))
  await waitFor(() => expect(renamePath).toHaveBeenCalledWith(7, '/a.txt', '/b.txt'))
  await waitFor(() => expect(d.refetch).toHaveBeenCalled())
})

test('delete flow: destructive confirm names the entry, dirs warn recursive, rm + refresh', async () => {
  const d = dirData([dirEnt('sub')])
  ;(useDir as jest.Mock).mockReturnValue(d)
  ;(rmPath as jest.Mock).mockResolvedValue({ ok: true })
  const { getByLabelText } = render(<FileBrowser />)
  fireEvent.press(getByLabelText('Actions for sub'))
  pressAlertButton(0, 'Delete')
  expect(alertSpy.mock.calls[1][0]).toBe('Delete sub?')
  expect(String(alertSpy.mock.calls[1][1])).toMatch(/everything inside/i)
  pressAlertButton(1, 'Delete')
  await waitFor(() => expect(rmPath).toHaveBeenCalledWith(7, '/sub', true))
  await waitFor(() => expect(d.refetch).toHaveBeenCalled())
})

test('delete failure surfaces an inline error', async () => {
  ;(useDir as jest.Mock).mockReturnValue(dirData([fileEnt('a.txt', 1)]))
  ;(rmPath as jest.Mock).mockRejectedValue(new Error('rm: not permitted'))
  const { getByLabelText, getByText } = render(<FileBrowser />)
  fireEvent.press(getByLabelText('Actions for a.txt'))
  pressAlertButton(0, 'Delete')
  pressAlertButton(1, 'Delete')
  await waitFor(() => expect(getByText('rm: not permitted')).toBeTruthy())
  expect(rmPath).toHaveBeenCalledWith(7, '/a.txt', false)
})
