// Run with `bun test core omp`. Named .spec.ts so `claude plugin test`, which takes every *.test.ts, leaves it to bun.
import { describe, expect, test } from 'bun:test'

import { DEFAULT_GUARD, classifierPrompt, classify, decide, guardedTier, parseSubagents, parseTier, subagentTier, tierOf } from './router'
import type { Policy } from './router'

const POLICY: Policy = {
  quotaGuard: DEFAULT_GUARD,
  subagents: { scout: 'light', task: 'standard', 'egm-design': 'heavy' },
}

describe('classify', () => {
  test('a short lookup is light', () => {
    expect(classify('what does parse_args return?').tier).toBe('light')
    expect(classify('commit this').tier).toBe('light')
  })
  test('design and root-cause work is heavy', () => {
    expect(classify('Investigate why the nightly sync intermittently loses rows and find the root cause').tier).toBe('heavy')
    expect(classify('design the migration of the queue across all services, trade-offs please').tier).toBe('heavy')
  })
  test('an ordinary edit is standard', () => {
    expect(classify('add a --dry-run flag to deploy.sh and update its test').tier).toBe('standard')
  })
  test('a heavy word beside a lookup start is not light', () => {
    expect(classify('show me the security audit findings').tier).not.toBe('light')
  })
  test('words inside code fences do not count', () => {
    expect(classify('fix this ```\nrace condition deadlock migrate audit\n``` typo').tier).not.toBe('heavy')
  })
  test('three named files and a four-part list make a prompt heavy', () => {
    expect(classify('update these:\n- src/a.ts\n- src/b.ts\n- src/c.ts\n- the changelog').tier).toBe('heavy')
  })
})

describe('guardedTier', () => {
  test('heavy is held to standard from 70% of the quota', () => {
    expect(guardedTier('heavy', 0.69, DEFAULT_GUARD)).toBe('heavy')
    expect(guardedTier('heavy', 0.7, DEFAULT_GUARD)).toBe('standard')
    expect(guardedTier('standard', 0.7, DEFAULT_GUARD)).toBe('standard')
  })
  test('everything is light from 90%', () => {
    expect(guardedTier('standard', 0.9, DEFAULT_GUARD)).toBe('light')
    expect(guardedTier('heavy', 0.95, DEFAULT_GUARD)).toBe('light')
  })
  test('an unknown quota, or a guard switched off, holds nothing back', () => {
    expect(guardedTier('heavy', undefined, DEFAULT_GUARD)).toBe('heavy')
    expect(guardedTier('heavy', 0.99, { ...DEFAULT_GUARD, enabled: false })).toBe('heavy')
  })
})

describe('the classifier', () => {
  test('is shown the end of the last reply, then the request', () => {
    expect(classifierPrompt('yes, do it', `${'x'.repeat(900)} Shall I redesign the queue?`)).toMatch(/^End of the assistant's last reply:\nx{572} Shall I redesign the queue\?\n\nNext request:\nyes, do it$/)
    expect(classifierPrompt('what is this?', ' ')).toBe('Next request:\nwhat is this?')
  })
  test('its reply is read for the tier it names', () => {
    expect(parseTier('Heavy.')).toBe('heavy')
    expect(parseTier('standard')).toBe('standard')
    expect(parseTier('I cannot tell')).toBeUndefined()
    expect(parseTier('')).toBeUndefined()
  })
})

describe('decide', () => {
  test('says what it did and why', () => {
    expect(decide('light', { current: 'heavy' }, POLICY)).toEqual({ tier: 'light', action: 'switch', why: 'light work: moved to the light model' })
    expect(decide('heavy', { current: 'heavy' }, POLICY)).toEqual({ tier: 'heavy', action: 'keep', why: 'heavy work: already on the heavy model' })
    expect(decide('heavy', { current: 'light', quotaUsed: 0.8 }, POLICY)).toEqual({ tier: 'standard', action: 'switch', why: 'heavy work, held to standard by the quota guard: moved to the standard model' })
    expect(decide('heavy', { current: 'standard', quotaUsed: 0.8 }, POLICY)).toEqual({ tier: 'standard', action: 'keep', why: 'heavy work, held to standard by the quota guard: already on the standard model' })
  })
  test('a model that serves no tier is left for the tier the prompt asks for', () => {
    expect(decide('standard', {}, POLICY)).toMatchObject({ tier: 'standard', action: 'switch' })
  })
})

describe('tierOf', () => {
  test('finds the tier a model serves', () => {
    const models = { light: 'h', standard: 's', heavy: 'o' }
    expect(tierOf('s', models)).toBe('standard')
    expect(tierOf('fable', models)).toBeUndefined()
    expect(tierOf(undefined, models)).toBeUndefined()
  })
})

describe('subagentTier', () => {
  test('looks the type up whole, then without its plugin prefix', () => {
    expect(subagentTier('scout', undefined, POLICY)).toEqual({ wanted: 'light', tier: 'light' })
    expect(subagentTier('egm:egm-design', undefined, POLICY)).toEqual({ wanted: 'heavy', tier: 'heavy' })
  })
  test('an agent not listed, or no type at all, is left alone', () => {
    expect(subagentTier('unknown', undefined, POLICY)).toBeUndefined()
    expect(subagentTier(undefined, undefined, POLICY)).toBeUndefined()
  })
  test('the quota guard applies to subagents too', () => {
    expect(subagentTier('egm-design', 0.75, POLICY)).toEqual({ wanted: 'heavy', tier: 'standard' })
  })
})

describe('parseSubagents', () => {
  test('reads an object or its JSON text and drops entries that are not tiers', () => {
    expect(parseSubagents({ a: 'heavy', b: 'huge', c: 3 })).toEqual({ a: 'heavy' })
    expect(parseSubagents('{"Explore":"light"}')).toEqual({ Explore: 'light' })
  })
  test('anything else is no table', () => {
    expect(parseSubagents('')).toBeUndefined()
    expect(parseSubagents('not json')).toBeUndefined()
    expect(parseSubagents(['light'])).toBeUndefined()
    expect(parseSubagents(undefined)).toBeUndefined()
  })
})
