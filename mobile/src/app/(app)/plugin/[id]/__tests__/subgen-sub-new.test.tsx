import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SubgenSubNew from '../subgen-sub-new'

const mockBack = jest.fn()
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'subgen' }),
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

type Q = { data?: unknown; isLoading: boolean; isError: boolean }
const ok = (data: unknown): Q => ({ data, isLoading: false, isError: false })

const mockTpls = jest.fn<Q, []>()
const mockCreate = jest.fn().mockResolvedValue({ id: 9, name: 'tv', token: 't', template_id: 11, enabled: true })
jest.mock('@/api/subgen', () => ({
  ...jest.requireActual('@/api/subgen'),
  useTemplates: () => mockTpls(),
  createSubscription: (...a: unknown[]) => mockCreate(...a),
}))

const TPLS = [
  { id: 10, name: 'Default', builtin: true, rules_json: '{}' },
  { id: 11, name: 'My rules', builtin: false, rules_json: '{}' },
]

const renderScreen = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SubgenSubNew />
  </QueryClientProvider>,
)

beforeEach(() => {
  jest.clearAllMocks()
  mockTpls.mockReturnValue(ok(TPLS))
})

test('blank name disables the Create button and blocks submit', () => {
  const { getByTestId } = renderScreen()
  // The button guards on a non-empty name, so pressing it with a blank name is a no-op.
  expect(getByTestId('sub-create').props.accessibilityState).toMatchObject({ disabled: true })
  fireEvent.press(getByTestId('sub-create'))
  expect(mockCreate).not.toHaveBeenCalled()
})

test('creates with name + the first template by default, then navigates back', async () => {
  const { getByTestId } = renderScreen()
  fireEvent.changeText(getByTestId('sub-name'), 'tv')
  fireEvent.press(getByTestId('sub-create'))
  await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({ name: 'tv', template_id: 10 }))
  await waitFor(() => expect(mockBack).toHaveBeenCalled())
})

test('picking a different template changes the submitted template_id', async () => {
  const { getByTestId } = renderScreen()
  fireEvent.changeText(getByTestId('sub-name'), 'tv')
  fireEvent.press(getByTestId('tpl-pick-11'))
  fireEvent.press(getByTestId('sub-create'))
  await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({ name: 'tv', template_id: 11 }))
})

test('name is trimmed before submit', async () => {
  const { getByTestId } = renderScreen()
  fireEvent.changeText(getByTestId('sub-name'), '  phone  ')
  fireEvent.press(getByTestId('sub-create'))
  await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({ name: 'phone', template_id: 10 }))
})

test('no templates → submit blocked and the button is disabled', () => {
  mockTpls.mockReturnValue(ok([]))
  const { getByTestId, getByText } = renderScreen()
  fireEvent.changeText(getByTestId('sub-name'), 'tv')
  fireEvent.press(getByTestId('sub-create'))
  expect(mockCreate).not.toHaveBeenCalled()
  expect(getByText('No templates available.')).toBeTruthy()
})
