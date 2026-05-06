import { describe, expect, it, beforeEach } from 'vitest'
import { useUI } from './ui'

beforeEach(() => {
  useUI.setState({ themeMode: 'system', lang: 'zh-CN', toasts: [] })
})

describe('useUI', () => {
  it('toast pushes to queue with monotonic ids', () => {
    useUI.getState().toast('info', 'a')
    useUI.getState().toast('error', 'b')
    const ts = useUI.getState().toasts
    expect(ts).toHaveLength(2)
    expect(ts[0].kind).toBe('info')
    expect(ts[1].kind).toBe('error')
    expect(ts[1].id).toBeGreaterThan(ts[0].id)
  })

  it('dismissToast removes by id', () => {
    useUI.getState().toast('info', 'a')
    const id = useUI.getState().toasts[0].id
    useUI.getState().dismissToast(id)
    expect(useUI.getState().toasts).toHaveLength(0)
  })

  it('setTheme + setLang update store', () => {
    useUI.getState().setTheme('dark')
    useUI.getState().setLang('en')
    const s = useUI.getState()
    expect(s.themeMode).toBe('dark')
    expect(s.lang).toBe('en')
  })
})
