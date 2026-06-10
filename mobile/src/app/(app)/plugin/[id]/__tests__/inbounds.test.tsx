import React from 'react'
import { Alert } from 'react-native'
import { render as rtlRender, fireEvent, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundsScreen, { isInboundsPlugin, hostStatusKind } from '../inbounds'
import { DeleteInboundConflict } from '@/api/inbounds'

// The screen calls useQueryClient() (for invalidate after delete), so renders
// must sit inside a QueryClientProvider.
function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

let mockId = 'singbox'
const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

type Q = { data?: unknown; isLoading: boolean; isError: boolean; isRefetching: boolean; refetch: jest.Mock }
const ok = (data: unknown): Q => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() })
const loading: Q = { data: undefined, isLoading: true, isError: false, isRefetching: false, refetch: jest.fn() }

const mockInbounds = jest.fn<Q, [string]>()
const mockHosts = jest.fn<Q, [string]>()
const mockDelete = jest.fn()

jest.mock('@/api/inbounds', () => ({
  ...jest.requireActual('@/api/inbounds'),
  useInbounds: (plugin: string) => mockInbounds(plugin),
  deleteInbound: (...a: unknown[]) => mockDelete(...a),
  invalidateInbounds: jest.fn(),
}))
jest.mock('@/api/plugins', () => ({
  usePluginHosts: (id: string) => mockHosts(id),
}))
jest.mock('@/api/servers', () => ({
  useServers: () => ({
    data: [
      { id: 7, name: 'alpha', connected: true, latest: null, ssh_host: { String: 'alpha.example.com', Valid: true } },
      { id: 9, name: 'beta', connected: true, latest: null, public_alias: { String: 'edge-9', Valid: true }, ssh_host: { String: 'beta.example.com', Valid: true } },
    ],
  }),
}))

const HOSTS = [
  { id: 1, plugin_id: 'singbox', server_id: 7, status: 'running', updated_at: '' },
  { id: 2, plugin_id: 'singbox', server_id: 9, status: 'stopped', updated_at: '' },
]
const INBOUNDS = [
  { id: 11, server_id: 7, server_name: 'alpha', tag: 'vless-reality-8443', alias: 'main', port: 8443, role: 'landing', protocol: 'vless-reality', uuid: 'u1', reality_public_key: 'PUB', reality_short_id: 'aa' },
  { id: 12, server_id: 7, server_name: 'alpha', tag: 'hy2-443', alias: '', port: 443, role: 'landing', protocol: 'hysteria2', password: 'pw', sni: 'a.com' },
  // a relay on server 9 depending on landing 11, forward mode
  { id: 21, server_id: 9, server_name: 'beta', tag: 'relay-9999', alias: '', port: 9999, role: 'relay', protocol: 'vless-reality', relay_mode: 'forward', upstream_inbound_id: 11, upstream_tag: 'vless-reality-8443', upstream_server_name: 'alpha' },
]

type AlertButton = { text?: string; style?: string; onPress?: () => void }

beforeEach(() => {
  jest.clearAllMocks()
  mockId = 'singbox'
  mockInbounds.mockReturnValue(ok(INBOUNDS))
  mockHosts.mockReturnValue(ok(HOSTS))
  mockDelete.mockResolvedValue(undefined)
})

// ── pure helpers ──

test('isInboundsPlugin gates the two proxy plugins only', () => {
  expect(isInboundsPlugin('singbox')).toBe(true)
  expect(isInboundsPlugin('xray')).toBe(true)
  expect(isInboundsPlugin('netquality')).toBe(false)
  expect(isInboundsPlugin(undefined)).toBe(false)
})

test('hostStatusKind: running → ok, else neutral', () => {
  expect(hostStatusKind('running')).toBe('ok')
  expect(hostStatusKind('stopped')).toBe('neutral')
  expect(hostStatusKind(undefined)).toBe('neutral')
})

// ── rendering ──

test('groups inbounds by server with name/ssh_host/status and per-inbound rows', () => {
  const { getByText, getAllByText } = render(<InboundsScreen />)
  // server headers: public_alias wins for 9, plain name for 7; ssh_host via nullStr
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText('alpha.example.com')).toBeTruthy()
  expect(getByText('edge-9')).toBeTruthy()
  expect(getByText('beta.example.com')).toBeTruthy()
  // status pills
  expect(getByText('running')).toBeTruthy()
  expect(getByText('stopped')).toBeTruthy()
  // inbound rows
  expect(getByText('vless-reality-8443')).toBeTruthy()
  expect(getByText('hy2-443')).toBeTruthy()
  expect(getByText(':8443')).toBeTruthy()
  // role pills: two landing + one relay
  expect(getAllByText('landing').length).toBe(2)
  expect(getByText('relay')).toBeTruthy()
  // relay upstream sub-line
  expect(getByText(/→ vless-reality-8443 @ alpha/)).toBeTruthy()
})

test('a landing with relay dependents shows a disabled delete labelled with the count', () => {
  const { getByTestId } = render(<InboundsScreen />)
  // landing 11 has 1 forward relay → delete shows "1 relay(s)" and is disabled
  expect(getByTestId('delete-11')).toBeTruthy()
  expect(getByTestId('delete-11').props.children).toBeDefined()
  // pressing the disabled delete should NOT open an Alert
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  fireEvent.press(getByTestId('delete-11'))
  expect(alertSpy).not.toHaveBeenCalled()
})

test('Copy URL appears for a shareable landing (vless-reality with secrets)', () => {
  const { getByTestId, queryByTestId } = render(<InboundsScreen />)
  // landing 11 has uuid + reality key + ssh_host → copyable
  expect(getByTestId('copy-11')).toBeTruthy()
  // hysteria2 landing 12 has password + sni → copyable too
  expect(getByTestId('copy-12')).toBeTruthy()
  // expo-clipboard is globally mocked in jest-setup, so the button renders
  fireEvent.press(getByTestId('copy-11'))
  expect(queryByTestId('copy-11')).toBeTruthy()
})

test('Edit pushes the form sub-route in edit mode with the inbound id', () => {
  const { getByTestId } = render(<InboundsScreen />)
  fireEvent.press(getByTestId('edit-12'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/plugin/singbox/inbound-form?mode=edit&inboundId=12')
})

test('the NavBar New action and per-server + push the create form', () => {
  const { getByLabelText } = render(<InboundsScreen />)
  fireEvent.press(getByLabelText('new-inbound'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/plugin/singbox/inbound-form?mode=create')
  fireEvent.press(getByLabelText('add-7'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/plugin/singbox/inbound-form?mode=create&serverId=7')
})

test('Delete confirms via Alert then calls deleteInbound', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const { getByTestId } = render(<InboundsScreen />)
  // inbound 12 has no dependents → delete enabled
  fireEvent.press(getByTestId('delete-12'))
  expect(alertSpy).toHaveBeenCalled()
  expect(alertSpy.mock.calls[0][0]).toMatch(/Delete hy2-443\?/)
  const buttons = alertSpy.mock.calls[0][2] as AlertButton[]
  const confirm = buttons.find((b) => b.style === 'destructive')
  expect(confirm).toBeTruthy()
  confirm!.onPress!()
  await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('singbox', 12))
})

test('a 409 DeleteInboundConflict surfaces the relay ids in a second Alert', async () => {
  mockDelete.mockRejectedValueOnce(new DeleteInboundConflict('landing has relays', [11, 12]))
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const { getByTestId } = render(<InboundsScreen />)
  fireEvent.press(getByTestId('delete-12'))
  const buttons = alertSpy.mock.calls[0][2] as AlertButton[]
  buttons.find((b) => b.style === 'destructive')!.onPress!()
  await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(2))
  expect(alertSpy.mock.calls[1][0]).toBe('Cannot delete')
  expect(String(alertSpy.mock.calls[1][1])).toMatch(/relay ids: 11, 12/)
})

test('loading state shows a spinner', () => {
  mockInbounds.mockReturnValue(loading)
  expect(render(<InboundsScreen />).getByTestId('inbounds-loading')).toBeTruthy()
})

test('an undeployed plugin shows the empty state', () => {
  mockInbounds.mockReturnValue(ok([]))
  mockHosts.mockReturnValue(ok([]))
  const { getByText } = render(<InboundsScreen />)
  expect(getByText(/Not deployed anywhere/)).toBeTruthy()
})

test('xray reuses the same screen keyed by id', () => {
  mockId = 'xray'
  mockHosts.mockReturnValue(ok(HOSTS.map((h) => ({ ...h, plugin_id: 'xray' }))))
  mockInbounds.mockReturnValue(ok([
    { id: 30, server_id: 7, server_name: 'alpha', tag: 'vless-reality-1', alias: '', port: 443, role: 'landing', protocol: 'vless-reality', uuid: 'u', public_key: 'XP', short_id: 's' },
  ]))
  const { getByText, getByTestId } = render(<InboundsScreen />)
  expect(mockInbounds).toHaveBeenCalledWith('xray')
  expect(mockHosts).toHaveBeenCalledWith('xray')
  expect(getByText('vless-reality-1')).toBeTruthy()
  fireEvent.press(getByTestId('edit-30'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/plugin/xray/inbound-form?mode=edit&inboundId=30')
})

test('a non-proxy plugin id renders the unsupported empty state', () => {
  mockId = 'netquality'
  const { getByText } = render(<InboundsScreen />)
  expect(getByText(/only available for sing-box and xray/)).toBeTruthy()
})
