import { describe, expect, it, beforeEach } from 'vitest'
import { useAuth } from './auth'

beforeEach(() => {
  useAuth.setState({ admin: null, isLoaded: false })
})

describe('useAuth', () => {
  it('starts unloaded with no admin', () => {
    const s = useAuth.getState()
    expect(s.admin).toBeNull()
    expect(s.isLoaded).toBe(false)
  })

  it('setAdmin marks store loaded', () => {
    useAuth.getState().setAdmin({ id: 1, username: 'alice' })
    const s = useAuth.getState()
    expect(s.admin?.username).toBe('alice')
    expect(s.isLoaded).toBe(true)
  })

  it('clear nulls admin but keeps loaded flag', () => {
    useAuth.getState().setAdmin({ id: 1, username: 'alice' })
    useAuth.getState().clear()
    const s = useAuth.getState()
    expect(s.admin).toBeNull()
    expect(s.isLoaded).toBe(true)
  })
})
