// Run with `bun test core omp` (see core/router.spec.ts for the file name).
import { describe, expect, test } from 'bun:test'

import { DEFAULT_CONFIG, hintsFor, mergeConfig, quotaUsedFrom } from './router'

describe('mergeConfig', () => {
  test('no file, or one that is not an object, is the defaults', () => {
    expect(mergeConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(mergeConfig('nope')).toEqual(DEFAULT_CONFIG)
  })
  test('keeps the defaults for anything of the wrong shape', () => {
    const cfg = mergeConfig({ tiers: { heavy: 'x/y', light: 5 }, quotaGuard: { holdHeavyAt: 0.5, lightOnlyAt: 'soon' } })
    expect(cfg.tiers).toEqual({ ...DEFAULT_CONFIG.tiers, heavy: 'x/y' })
    expect(cfg.quotaGuard).toEqual({ ...DEFAULT_CONFIG.quotaGuard, holdHeavyAt: 0.5 })
  })
  test('a subagents table replaces the default one', () => {
    expect(mergeConfig({ subagents: { mine: 'heavy', bad: 'huge' } }).subagents).toEqual({ mine: 'heavy' })
  })
  test('never hands out the shared defaults', () => {
    mergeConfig(undefined).quotaGuard.enabled = false
    expect(DEFAULT_CONFIG.quotaGuard.enabled).toBe(true)
  })
})

describe('quotaUsedFrom', () => {
  const report = (limits: unknown[]) => ({ reports: [{ provider: 'anthropic', limits }] })
  test('reads the 7-day limit, not the 5-hour one', () => {
    const json = report([
      { id: 'anthropic:5h', amount: { usedFraction: 0.99 } },
      { id: 'anthropic:7d', amount: { usedFraction: 0.72 } },
    ])
    expect(quotaUsedFrom(json)).toBe(0.72)
  })
  test('takes the fullest of several accounts', () => {
    const json = { reports: [report([{ id: 'anthropic:7d', amount: { usedFraction: 0.2 } }]).reports[0], report([{ id: 'anthropic:7d', amount: { usedFraction: 0.8 } }]).reports[0]] }
    expect(quotaUsedFrom(json)).toBe(0.8)
  })
  test('is undefined when the report has no such limit', () => {
    expect(quotaUsedFrom({})).toBeUndefined()
    expect(quotaUsedFrom(report([]))).toBeUndefined()
  })
})

describe('hintsFor', () => {
  const hints = { pdfcraft: '\\bpdf\\b', rea: '\\bdecompil\\w*', broken: '(' }
  test('names a switched-off server the prompt asks for, once', () => {
    expect(hintsFor('merge these PDF files', hints, ['pdfcraft', 'rea'], new Set())).toEqual(['pdfcraft'])
    expect(hintsFor('merge these PDF files', hints, ['pdfcraft', 'rea'], new Set(['pdfcraft']))).toEqual([])
  })
  test('says nothing about a server that is on', () => {
    expect(hintsFor('decompile this apk', hints, ['pdfcraft'], new Set())).toEqual([])
  })
  test('a pattern that does not compile hints at nothing', () => {
    expect(hintsFor('anything (', hints, ['broken'], new Set())).toEqual([])
  })
})
