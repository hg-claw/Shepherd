import { b64encode, b64decode, dataMsg, fitMsg, parseFromWebView } from '../bridge'

test('base64 round-trips arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 27, 91, 65, 255, 10])
  expect(b64decode(b64encode(bytes))).toEqual(bytes)
})
test('dataMsg/fitMsg shapes', () => {
  expect(JSON.parse(dataMsg(new Uint8Array([65]))).type).toBe('data')
  expect(JSON.parse(fitMsg()).type).toBe('fit')
})
test('parseFromWebView decodes input/resize/ready, null on garbage', () => {
  const i = parseFromWebView(JSON.stringify({ type: 'input', b64: b64encode(new Uint8Array([97])) }))
  expect(i).toEqual({ type: 'input', bytes: new Uint8Array([97]) })
  expect(parseFromWebView(JSON.stringify({ type: 'resize', rows: 24, cols: 80 }))).toEqual({ type: 'resize', rows: 24, cols: 80 })
  expect(parseFromWebView(JSON.stringify({ type: 'ready' }))).toEqual({ type: 'ready' })
  expect(parseFromWebView(JSON.stringify({ type: 'copy', text: 'hello' }))).toEqual({ type: 'copy', text: 'hello' })
  expect(parseFromWebView(JSON.stringify({ type: 'selecttext', text: 'a\nb' }))).toEqual({ type: 'selecttext', text: 'a\nb' })
  expect(parseFromWebView(JSON.stringify({ type: 'selecttext' }))).toBeNull()
  expect(parseFromWebView('not json')).toBeNull()
  expect(parseFromWebView(JSON.stringify({ type: 'nope' }))).toBeNull()
})
