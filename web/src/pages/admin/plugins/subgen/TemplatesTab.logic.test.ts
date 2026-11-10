// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseRules, selectedToDisabled } from './TemplatesTab'

describe('subgen template selection logic', () => {
  it('keeps private defaults for legacy templates and preserves an explicit DNS mode', () => {
    expect(parseRules('{}').dns_mode).toBe('private')
    expect(parseRules('{"dns_mode":"rule-aware"}').dns_mode).toBe('rule-aware')
    // Do not silently coerce invalid raw modes to private; backend validation rejects them.
    expect(parseRules('{"dns_mode":"invalid"}').dns_mode).toBe('invalid')
  })

  it('defaults disabled_groups to [] when the key is absent (legacy → all checked)', () => {
    expect(parseRules('{"final":"PROXY"}').disabled_groups).toEqual([])
  })

  it('reads disabled_groups when present', () => {
    expect(parseRules('{"disabled_groups":["Netflix","Steam"]}').disabled_groups)
      .toEqual(['Netflix', 'Steam'])
  })

  it('selectedToDisabled returns catalog members not in the checked set, in order', () => {
    const all = ['AdBlock', 'Netflix', 'YouTube', 'Steam']
    const checked = new Set(['AdBlock', 'YouTube'])
    expect(selectedToDisabled(all, checked)).toEqual(['Netflix', 'Steam'])
  })

  it('selectedToDisabled returns [] when everything is checked', () => {
    const all = ['AdBlock', 'Netflix']
    expect(selectedToDisabled(all, new Set(all))).toEqual([])
  })
})
