import React from 'react'
import { render as rtlRender, fireEvent, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundFormScreen from '../inbound-form'

// The form calls useQueryClient() (invalidate after save), so renders must sit
// inside a QueryClientProvider.
function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

let mockParams: Record<string, string> = { id: 'singbox', mode: 'create', serverId: '7' }
const mockBack = jest.fn()
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}))

const mockUseInbounds = jest.fn()
const mockCreate = jest.fn()
const mockPatch = jest.fn()
const mockX25519 = jest.fn()
const mockShortID = jest.fn()
jest.mock('@/api/inbounds', () => ({
  ...jest.requireActual('@/api/inbounds'),
  useInbounds: () => mockUseInbounds(),
  createInbound: (...a: unknown[]) => mockCreate(...a),
  patchInbound: (...a: unknown[]) => mockPatch(...a),
  invalidateInbounds: jest.fn(),
  generateX25519: (...a: unknown[]) => mockX25519(...a),
  generateShortID: (...a: unknown[]) => mockShortID(...a),
}))

const EDIT_ROW = {
  id: 12, server_id: 7, server_name: 'alpha', tag: 'hy2-443', alias: 'old', port: 443,
  role: 'landing', protocol: 'hysteria2', password: 'pw', sni: 'a.com',
}
const XRAY_EDIT = {
  id: 30, server_id: 7, server_name: 'alpha', tag: 'vless-reality-1', alias: '', port: 443,
  role: 'landing', protocol: 'vless-reality', uuid: 'u', public_key: 'XP', short_id: 'sid0', sni: 's.com',
}

beforeEach(() => {
  jest.clearAllMocks()
  mockParams = { id: 'singbox', mode: 'create', serverId: '7' }
  mockUseInbounds.mockReturnValue({ data: [EDIT_ROW, XRAY_EDIT] })
  mockCreate.mockResolvedValue({ id: 99 })
  mockPatch.mockResolvedValue({ id: 99 })
  mockX25519.mockResolvedValue({ private_key: 'PRIV', public_key: 'PUB' })
  mockShortID.mockResolvedValue({ short_id: 'SHORT' })
})

// ── sing-box create ──

test('singbox create defaults to vless-reality and shows the REALITY group', () => {
  const { getByTestId, getByText } = render(<InboundFormScreen />)
  expect(getByText('REALITY')).toBeTruthy()
  expect(getByTestId('port')).toBeTruthy()
  expect(getByTestId('uuid')).toBeTruthy() // vless needs uuid
  expect(getByTestId('pubkey')).toBeTruthy()
})

test('switching protocol re-derives conditional groups (no effect, pure useMemo)', () => {
  const { getByTestId, queryByTestId, getByText } = render(<InboundFormScreen />)
  // pick shadowsocks-2022 → SS method + key appear, REALITY gone, UUID gone
  fireEvent.press(getByTestId('protocol-shadowsocks-2022'))
  expect(queryByTestId('pubkey')).toBeNull()
  expect(queryByTestId('uuid')).toBeNull()
  expect(getByTestId('ssmethod')).toBeTruthy()
  expect(getByTestId('sspassword')).toBeTruthy()
  expect(getByText('Method')).toBeTruthy()
})

test('singbox create posts role=landing, no tag, with the reality fields', async () => {
  const { getByTestId } = render(<InboundFormScreen />)
  fireEvent.changeText(getByTestId('port'), '8443')
  // generate a keypair so private key is non-empty
  fireEvent.press(getByTestId('save'))
  await waitFor(() => expect(mockCreate).toHaveBeenCalled())
  const [plugin, body] = mockCreate.mock.calls[0]
  expect(plugin).toBe('singbox')
  expect(body.role).toBe('landing')
  expect(body.server_id).toBe(7)
  expect(body.protocol).toBe('vless-reality')
  expect(body).not.toHaveProperty('tag')
  expect(mockBack).toHaveBeenCalled()
})

test('Generate keypair calls the shared xray endpoint and fills public key', async () => {
  const { getByText, getByTestId } = render(<InboundFormScreen />)
  fireEvent.press(getByText('Generate keypair'))
  await waitFor(() => expect(mockX25519).toHaveBeenCalled())
  expect(getByTestId('pubkey').props.value).toBe('PUB')
})

test('cert-backed TLS protocols are create-blocked on phone (save disabled)', async () => {
  const { getByTestId, getByText } = render(<InboundFormScreen />)
  fireEvent.press(getByTestId('protocol-vless-ws-tls'))
  expect(getByText(/web console/)).toBeTruthy()
  fireEvent.press(getByTestId('save'))
  await waitFor(() => {}) // allow any async to settle
  expect(mockCreate).not.toHaveBeenCalled()
})

test('invalid port is rejected before any network call', async () => {
  const { getByTestId, getByText } = render(<InboundFormScreen />)
  fireEvent.changeText(getByTestId('port'), '70000')
  fireEvent.press(getByTestId('save'))
  expect(await waitFor(() => getByText(/port must be 1–65535/))).toBeTruthy()
  expect(mockCreate).not.toHaveBeenCalled()
})

// ── sing-box edit ──

test('singbox edit seeds from the cached row and PATCHes only present keys (no private key)', async () => {
  mockParams = { id: 'singbox', mode: 'edit', inboundId: '12' }
  const { getByTestId } = render(<InboundFormScreen />)
  // protocol is immutable in edit → no option list, just a hint
  expect(getByTestId('port').props.value).toBe('443')
  expect(getByTestId('alias').props.value).toBe('old')
  fireEvent.changeText(getByTestId('alias'), 'new')
  fireEvent.press(getByTestId('save'))
  await waitFor(() => expect(mockPatch).toHaveBeenCalled())
  const [plugin, id, body] = mockPatch.mock.calls[0]
  expect(plugin).toBe('singbox')
  expect(id).toBe(12)
  expect(body.alias).toBe('new')
  // hysteria2 edit: no reality keys leak in
  expect(body).not.toHaveProperty('reality_private_key')
  expect(mockBack).toHaveBeenCalled()
})

test('edit of a missing inbound id shows a not-found empty state', () => {
  mockParams = { id: 'singbox', mode: 'edit', inboundId: '999' }
  const { getByText } = render(<InboundFormScreen />)
  expect(getByText(/Inbound not found/)).toBeTruthy()
})

// ── xray ──

test('xray create uses its 3-protocol scheme and posts role=landing', async () => {
  mockParams = { id: 'xray', mode: 'create', serverId: '7' }
  const { getByTestId } = render(<InboundFormScreen />)
  expect(getByTestId('protocol-vmess-ws')).toBeTruthy()
  expect(getByTestId('protocol-shadowsocks')).toBeTruthy()
  fireEvent.changeText(getByTestId('port'), '443')
  fireEvent.press(getByTestId('save'))
  await waitFor(() => expect(mockCreate).toHaveBeenCalled())
  const [plugin, body] = mockCreate.mock.calls[0]
  expect(plugin).toBe('xray')
  expect(body.role).toBe('landing')
  expect(body.protocol).toBe('vless-reality')
})

test('xray edit only sends changed fields and omits an empty private_key', async () => {
  mockParams = { id: 'xray', mode: 'edit', inboundId: '30' }
  const { getByTestId } = render(<InboundFormScreen />)
  expect(getByTestId('port').props.value).toBe('443')
  // change only the short id
  fireEvent.changeText(getByTestId('shortid'), 'NEWSID')
  fireEvent.press(getByTestId('save'))
  await waitFor(() => expect(mockPatch).toHaveBeenCalled())
  const [plugin, id, body] = mockPatch.mock.calls[0]
  expect(plugin).toBe('xray')
  expect(id).toBe(30)
  expect(body.short_id).toBe('NEWSID')
  // unchanged fields are absent; private_key (empty) must NOT be sent (xray wipes empties)
  expect(body).not.toHaveProperty('private_key')
  expect(body).not.toHaveProperty('public_key')
  expect(body).not.toHaveProperty('sni')
})

test('xray edit sends private_key only when freshly generated', async () => {
  mockParams = { id: 'xray', mode: 'edit', inboundId: '30' }
  const { getByTestId, getByText } = render(<InboundFormScreen />)
  fireEvent.press(getByText('Generate keypair'))
  await waitFor(() => expect(mockX25519).toHaveBeenCalled())
  fireEvent.press(getByTestId('save'))
  await waitFor(() => expect(mockPatch).toHaveBeenCalled())
  const body = mockPatch.mock.calls[0][2]
  expect(body.private_key).toBe('PRIV')
  expect(body.public_key).toBe('PUB')
})

test('create without a serverId param prompts to pick a server', () => {
  mockParams = { id: 'singbox', mode: 'create' }
  const { getByText } = render(<InboundFormScreen />)
  expect(getByText(/Pick a server/)).toBeTruthy()
})

test('non-proxy plugin shows the unsupported empty state', () => {
  mockParams = { id: 'netquality', mode: 'create', serverId: '7' }
  const { getByText } = render(<InboundFormScreen />)
  expect(getByText(/only available for sing-box and xray/)).toBeTruthy()
})
