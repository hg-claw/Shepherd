// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { act } from 'react'
import { render, screen } from '@testing-library/react'
import { LiveNetCell } from './LiveNetCell'
import { useWallLiveStore } from '@/api/wallLive'

describe('LiveNetCell', () => {
  beforeEach(() => useWallLiveStore.setState({ live: {}, connected: false }))

  it('shows fallback when no live frame, then the live value', () => {
    render(
      <LiveNetCell id={5} fallbackRx={100} fallbackTx={200}>
        {(rx, tx) => <span>{`${rx}|${tx}`}</span>}
      </LiveNetCell>,
    )
    expect(screen.getByText('100|200')).toBeTruthy()
    act(() => useWallLiveStore.getState().setFrame(5, 7, 9))
    expect(screen.getByText('7|9')).toBeTruthy()
  })
})
