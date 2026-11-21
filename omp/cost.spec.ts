// Run with `bun test core omp`.
import { describe, expect, test } from 'bun:test'

import { summarise } from './cost'
import type { Request, Turn } from './sessions'

const request = (at: number, model: string, over: Partial<Request> = {}): Request => ({ at, model, input: 0, output: 0, read: 0, write: 0, billed: 0, ...over })

describe('summarise', () => {
  test('places a turn in the window of its first request, the end of a window excluded', () => {
    const turns: Turn[] = [
      { tier: 'standard', requests: [request(10, 'claude-opus-5-5'), request(500, 'claude-opus-5-5')] },
      { tier: 'standard', requests: [request(100, 'claude-opus-5-5')] },
      { tier: 'standard', requests: [request(9, 'claude-opus-5-5')] },
    ]
    expect(summarise(turns, 10, 100)).toMatchObject({ turns: 1, requests: 2 })
    expect(summarise(turns, 100, 200)).toMatchObject({ turns: 1, requests: 1 })
  })

  test('the index is 1 for Opus, and the share counts each model by what it was billed', () => {
    // 1M input + 1M output + 1M read + 1M write on Opus 5.5 is 4 + 20 + 0.2 + 8 = 32.2
    const tokens = { input: 1e6, output: 1e6, read: 1e6, write: 1e6 }
    const opus = { ...tokens, billed: 32.2 }
    const sonnet = { ...tokens, billed: 16.1 }
    const turns: Turn[] = [{ tier: 'light', requests: [request(1, 'claude-opus-5-5', opus), request(2, 'claude-sonnet-5-5', sonnet)] }]
    const s = summarise(turns, 0, 10)
    expect(s.index).toBeCloseTo(0.75, 10)
    expect(s.share['claude-opus-5-5']).toBeCloseTo(2 / 3, 10)
    expect(s.perRequest).toBeCloseTo(24.15, 10)
  })

  test('an empty window is zeros, not NaN', () => {
    expect(summarise([], 0, 10)).toMatchObject({ turns: 0, requests: 0, billed: 0, perTurn: 0, index: 0, medianContext: 0 })
  })
})
