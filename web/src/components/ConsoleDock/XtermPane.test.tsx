import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import { XtermPane } from './XtermPane'

beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({ matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }),
    })
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

describe('XtermPane', () => {
  it('opens a websocket on mount', () => {
    const orig = globalThis.WebSocket
    let opened = false
    class MockWS {
      binaryType = ''
      readyState = 0
      constructor(_url: string) {
        opened = true
      }
      onopen?: () => void
      onmessage?: (e: MessageEvent) => void
      send() {}
      close() {}
    }
    // @ts-expect-error mock
    globalThis.WebSocket = MockWS

    render(<XtermPane tabId="t" sid="abcdefghijklmnopqrstuv" />)
    expect(opened).toBe(true)

    globalThis.WebSocket = orig
  })
})
