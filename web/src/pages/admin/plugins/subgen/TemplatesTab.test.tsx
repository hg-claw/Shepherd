// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test-utils/render'

// Mock the api module so the editor's queries/mutations don't hit the network.
vi.mock('@/api/subgen', async (orig) => {
  const actual = await orig<typeof import('@/api/subgen')>()
  return {
    ...actual,
    listSubgenOixGroups: vi.fn().mockResolvedValue(['AdBlock', 'Netflix', 'YouTube']),
    previewSubgenTemplate: vi.fn().mockResolvedValue(''),
  }
})

import { TemplateEditor } from './TemplatesTab'

const noop = () => {}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TemplateEditor proxy-group checklist', () => {
  it('checks every group for a template with no disabled_groups (default all on)', async () => {
    renderWithProviders(
      <TemplateEditor editing={{ id: null, name: 'x', rules: '{}' }} onClose={noop} onSaved={noop} />,
    )
    const adblock = await screen.findByLabelText('group AdBlock') as HTMLInputElement
    const netflix = screen.getByLabelText('group Netflix') as HTMLInputElement
    const youtube = screen.getByLabelText('group YouTube') as HTMLInputElement
    expect(adblock.checked).toBe(true)
    expect(netflix.checked).toBe(true)
    expect(youtube.checked).toBe(true)
  })

  it('unchecks exactly the groups listed in disabled_groups', async () => {
    renderWithProviders(
      <TemplateEditor
        editing={{ id: 1, name: 'x', rules: '{"disabled_groups":["Netflix"]}' }}
        onClose={noop}
        onSaved={noop}
      />,
    )
    const netflix = await screen.findByLabelText('group Netflix') as HTMLInputElement
    const adblock = screen.getByLabelText('group AdBlock') as HTMLInputElement
    expect(netflix.checked).toBe(false)
    expect(adblock.checked).toBe(true)
  })
})
