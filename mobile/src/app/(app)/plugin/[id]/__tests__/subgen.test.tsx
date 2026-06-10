import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SubgenScreen, { hasSubgenView, templateLabel, keyOf } from '../subgen'

let mockId = 'subgen'
const mockBack = jest.fn()
const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: mockBack, push: mockPush }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

jest.mock('@/store/auth', () => ({
  useAuth: (sel: (s: { baseURL: string | null }) => unknown) => sel({ baseURL: 'https://h.example' }),
}))

type Q = { data?: unknown; isLoading: boolean; isError: boolean; isRefetching: boolean; refetch: jest.Mock }
const ok = (data: unknown): Q => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() })
const loading: Q = { data: undefined, isLoading: true, isError: false, isRefetching: false, refetch: jest.fn() }
const failed: Q = { data: undefined, isLoading: false, isError: true, isRefetching: false, refetch: jest.fn() }

const mockSubs = jest.fn<Q, []>()
const mockTpls = jest.fn<Q, []>()
const mockSubInbounds = jest.fn<Q, [number | null]>()
const mockProxy = jest.fn<Q, [string, boolean]>()
const mockUpdate = jest.fn().mockResolvedValue({})
const mockDelete = jest.fn().mockResolvedValue({})
const mockRotate = jest.fn().mockResolvedValue({ token: 'new' })
const mockDelTpl = jest.fn().mockResolvedValue({})
jest.mock('@/api/subgen', () => ({
  ...jest.requireActual('@/api/subgen'),
  useSubscriptions: () => mockSubs(),
  useTemplates: () => mockTpls(),
  useSubscriptionInbounds: (id: number | null) => mockSubInbounds(id),
  useAllProxyInbounds: (plugin: string, enabled: boolean) => mockProxy(plugin, enabled),
  updateSubscription: (...a: unknown[]) => mockUpdate(...a),
  deleteSubscription: (...a: unknown[]) => mockDelete(...a),
  rotateToken: (...a: unknown[]) => mockRotate(...a),
  deleteTemplate: (...a: unknown[]) => mockDelTpl(...a),
}))

const SUBS = [
  { id: 1, name: 'phone', token: 'tok-aaa', template_id: 10, enabled: true },
  { id: 2, name: 'laptop', token: 'tok-bbb', template_id: 11, enabled: false },
]
const TPLS = [
  { id: 10, name: 'Default', builtin: true, rules_json: '{}' },
  { id: 11, name: 'My rules', builtin: false, rules_json: '{}' },
]
const INBOUNDS_X = [{ id: 5, server_id: 7, server_name: 'alpha', tag: 'vless-5', alias: '', port: 8443, role: 'landing', protocol: 'vless' }]
const INBOUNDS_S = [{ id: 8, server_id: 9, server_name: 'beta', tag: 'hy2-8', alias: '', port: 443, role: 'landing', protocol: 'hysteria2' }]

const renderScreen = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SubgenScreen />
  </QueryClientProvider>,
)

beforeEach(() => {
  jest.clearAllMocks()
  mockId = 'subgen'
  mockSubs.mockReturnValue(ok(SUBS))
  mockTpls.mockReturnValue(ok(TPLS))
  mockSubInbounds.mockReturnValue(ok([{ source: 'xray', inbound_id: 5 }, { source: 'singbox', inbound_id: 8 }]))
  mockProxy.mockImplementation((plugin) => ok(plugin === 'xray' ? INBOUNDS_X : INBOUNDS_S))
})

// ── pure helpers ──────────────────────────────────────────────────────────────

test('hasSubgenView gates only the subgen id', () => {
  expect(hasSubgenView('subgen')).toBe(true)
  expect(hasSubgenView('xray')).toBe(false)
  expect(hasSubgenView(undefined)).toBe(false)
})

test('templateLabel resolves the id to a name, falling back to #id when deleted', () => {
  expect(templateLabel(10, TPLS as never)).toBe('Default')
  expect(templateLabel(99, TPLS as never)).toBe('#99')
})

test('keyOf builds the source:inbound_id de-dupe key', () => {
  expect(keyOf({ source: 'xray', inbound_id: 5 })).toBe('xray:5')
  expect(keyOf({ source: 'singbox', inbound_id: 8 })).toBe('singbox:8')
})

// ── subscriptions tab ───────────────────────────────────────────────────────────

test('subscriptions list shows name + template name + enabled pill (sorted)', () => {
  const { getByText, getAllByText } = renderScreen()
  expect(getByText('phone')).toBeTruthy()
  expect(getByText('laptop')).toBeTruthy()
  expect(getByText('Default')).toBeTruthy()   // template name for #10
  expect(getByText('My rules')).toBeTruthy()  // template name for #11
  expect(getAllByText('enabled').length).toBeGreaterThanOrEqual(1)
  expect(getByText('disabled')).toBeTruthy()
})

test('expanding a row builds the public /sub URL on the ROOT origin and re-targets via Segmented', () => {
  const { getByTestId, getByText } = renderScreen()
  fireEvent.press(getByTestId('sub-1'))
  // default target=surge, origin from auth store baseURL, NOT under /api
  expect(getByTestId('sub-url-1').props.children).toBe('https://h.example/sub/tok-aaa?target=surge')
  fireEvent.press(getByText('Clash'))
  expect(getByTestId('sub-url-1').props.children).toBe('https://h.example/sub/tok-aaa?target=clash')
})

test('expanded row resolves bundled nodes read-only via the inbound lists', () => {
  const { getByTestId, getByText, queryByText } = renderScreen()
  fireEvent.press(getByTestId('sub-1'))
  // xray #5 + singbox #8 resolve to tag · server — NOT the `#id` placeholder
  expect(getByText('· hy2-8 · beta')).toBeTruthy()
  expect(getByText('· vless-5 · alpha')).toBeTruthy()
  expect(queryByText('· singbox #8')).toBeNull()
  expect(queryByText('· xray #5')).toBeNull()
  // FULL (unfiltered) proxy inbound lists requested once the row is open — a
  // server_id filter (e.g. -1) returns empty and breaks node resolution.
  expect(mockProxy).toHaveBeenCalledWith('xray', true)
  expect(mockProxy).toHaveBeenCalledWith('singbox', true)
})

test('an unresolvable Selection keeps the graceful `source #id` fallback', () => {
  // singbox #8 has NO matching inbound (only xray #5 is present) → it must fall
  // back to the `singbox #8` placeholder while the resolvable xray node renders.
  mockProxy.mockImplementation((plugin) => ok(plugin === 'xray' ? INBOUNDS_X : []))
  const { getByTestId, getByText } = renderScreen()
  fireEvent.press(getByTestId('sub-1'))
  expect(getByText('· vless-5 · alpha')).toBeTruthy()
  expect(getByText('· singbox #8')).toBeTruthy()
})

test('copy uses the guarded expo-clipboard and shows confirmation', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const clip = require('expo-clipboard')
  const { getByTestId } = renderScreen()
  fireEvent.press(getByTestId('sub-1'))
  fireEvent.press(getByTestId('sub-copy-1'))
  expect(clip.setStringAsync).toHaveBeenCalledWith('https://h.example/sub/tok-aaa?target=surge')
  await waitFor(() => expect(getByTestId('sub-copy-1')).toBeTruthy())
})

test('toggling Enabled PATCHes the FULL triple from the current row', async () => {
  const { getByTestId } = renderScreen()
  fireEvent.press(getByTestId('sub-1'))
  fireEvent(getByTestId('sub-toggle-1'), 'onChange', false)
  await waitFor(() =>
    expect(mockUpdate).toHaveBeenCalledWith(1, { name: 'phone', template_id: 10, enabled: false }),
  )
})

test('Regenerate confirms via Alert.alert then rotates the token', async () => {
  const spy = jest.spyOn(Alert, 'alert')
  const { getByTestId } = renderScreen()
  fireEvent.press(getByTestId('sub-1'))
  fireEvent.press(getByTestId('sub-rotate-1'))
  // confirm dialog, not window.confirm
  expect(spy).toHaveBeenCalled()
  const buttons = spy.mock.calls[0][2] as { text: string; onPress?: () => void }[]
  await buttons.find((b) => b.text === 'Regenerate')!.onPress!()
  expect(mockRotate).toHaveBeenCalledWith(1)
  spy.mockRestore()
})

test('Revoke confirms via Alert.alert then deletes the subscription', async () => {
  const spy = jest.spyOn(Alert, 'alert')
  const { getByTestId } = renderScreen()
  fireEvent.press(getByTestId('sub-1'))
  fireEvent.press(getByTestId('sub-revoke-1'))
  expect(spy).toHaveBeenCalled()
  const buttons = spy.mock.calls[0][2] as { text: string; onPress?: () => void }[]
  await buttons.find((b) => b.text === 'Revoke')!.onPress!()
  expect(mockDelete).toHaveBeenCalledWith(1)
  spy.mockRestore()
})

test('New subscription pushes the create form sub-route', () => {
  const { getByTestId } = renderScreen()
  fireEvent.press(getByTestId('sub-new'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/plugin/subgen/subgen-sub-new')
})

test('loading shows a spinner; an error offers retry', () => {
  mockSubs.mockReturnValue(loading)
  expect(renderScreen().getByTestId('subs-loading')).toBeTruthy()
  const fq = { ...failed, refetch: jest.fn() }
  mockSubs.mockReturnValue(fq)
  const { getByText } = renderScreen()
  fireEvent.press(getByText('Retry'))
  expect(fq.refetch).toHaveBeenCalled()
})

test('empty subscription set shows the empty state', () => {
  mockSubs.mockReturnValue(ok([]))
  expect(renderScreen().getByText('No subscriptions yet.')).toBeTruthy()
})

// ── templates tab ────────────────────────────────────────────────────────────

test('Templates tab lists names with built-in/custom pills; delete only on custom', () => {
  const { getByText, queryByTestId, getByTestId } = renderScreen()
  fireEvent.press(getByText('Templates'))
  expect(getByText('built-in')).toBeTruthy()
  expect(getByText('custom')).toBeTruthy()
  // built-in (#10) has no delete button; custom (#11) does
  expect(queryByTestId('tpl-del-10')).toBeNull()
  expect(getByTestId('tpl-del-11')).toBeTruthy()
})

test('deleting a custom template confirms via Alert.alert', async () => {
  const spy = jest.spyOn(Alert, 'alert')
  const { getByText, getByTestId } = renderScreen()
  fireEvent.press(getByText('Templates'))
  fireEvent.press(getByTestId('tpl-del-11'))
  const buttons = spy.mock.calls[0][2] as { text: string; onPress?: () => void }[]
  await buttons.find((b) => b.text === 'Delete')!.onPress!()
  expect(mockDelTpl).toHaveBeenCalledWith(11)
  spy.mockRestore()
})

// ── unknown plugin ─────────────────────────────────────────────────────────────

test('non-subgen id renders the empty state and never queries', () => {
  mockId = 'xray'
  const { getByText } = renderScreen()
  expect(getByText('No subscription view for this plugin.')).toBeTruthy()
  expect(mockSubs).not.toHaveBeenCalled()
})
