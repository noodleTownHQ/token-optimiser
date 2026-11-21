import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { START, world } from './world'

const LOOKUP = 'what does parse_args return?'
const EDIT = 'add a --dry-run flag to deploy.sh and update its test'
const DESIGN = 'design the migration of the queue across all services, trade-offs please'

const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as const
const AGENT = { tool: 'Agent', description: 'look it up', prompt: 'look it up' } as const

/**
 * A session on Opus. `tokens` is the context size the engine reports (none before the first request) and `weekUsed` the
 * percent of the 7-day limit. `says` is the classifier's reply; while it is unset the classifier fails, so the rules decide.
 * `requests` collects the model each request went out with, `agents` the model each Agent call named, `asked` what the
 * classifier was shown.
 */
const session = (on: On, weekUsed?: number) => {
  world(on, {}, {})
  const s = {
    tokens: undefined as number | undefined,
    says: undefined as string | undefined,
    requests: [] as string[],
    agents: [] as (string | undefined)[],
    asked: [] as string[],
  }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, ...(s.tokens !== undefined && { tokens: s.tokens }) },
      rateLimits: weekUsed === undefined ? [] : [{ kind: 'seven_day', percentUsed: weekUsed, resetsAt: 0 }],
      cost: { usd: 0 },
    },
  }))
  on('model.complete', ($, e) => {
    s.asked.push(e.prompt)
    if (s.says === undefined) throw new Error('the classifier is down')
    return { value: { isAnswered: true, text: s.says, usage: {} as never } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    s.requests.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'Shall I rework the parser?', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', { tool: 'Agent' }, ($, e) => {
    s.agents.push(e.model)
    return { deny: 'no agents in this world' }
  })
  return s
}

const finish = async (stream: AsyncGenerator<unknown, unknown>) => {
  while (!(await stream.next()).done);
}

describe('routing the main loop', () => {
  test('a lookup in a new session runs on the light model, and the choice holds for the turn', async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.turn.start({ text: LOOKUP, turnId: 't1' })
    await finish($.turn.step(STEP))
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
  })

  test('the light model reads the prompt, with the end of the last reply beside it', async ($, on) => {
    const s = session(on)
    s.says = 'light'
    await $.session.start(START)
    await $.turn.start({ text: 'hello', turnId: 't1' })
    await finish($.turn.step(STEP))
    s.says = 'Standard.'
    await $.turn.start({ text: 'yes, do it', turnId: 't2' })
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(s.asked).toEqual(['Next request:\nhello', "End of the assistant's last reply:\nShall I rework the parser?\n\nNext request:\nyes, do it"])
  })

  test('a reply that names no tier leaves the prompt to the rules', async ($, on) => {
    const s = session(on)
    s.says = 'I cannot tell'
    await $.session.start(START)
    await $.turn.start({ text: EDIT, turnId: 't1' })
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-sonnet-5-5'])
  })

  test('a later prompt moves the loop while the context is still small', async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.turn.start({ text: LOOKUP, turnId: 't1' })
    await finish($.turn.step(STEP))
    s.tokens = 50_000
    await finish($.turn.step(STEP))
    s.tokens = 62_000
    await $.turn.start({ text: EDIT, turnId: 't2' })
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'])
  })

  test('past the ceiling the loop does not move down, so the cache is kept', async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.turn.start({ text: EDIT, turnId: 't1' })
    await finish($.turn.step(STEP))
    s.tokens = 50_000
    await finish($.turn.step(STEP))
    s.tokens = 90_000
    await $.turn.start({ text: LOOKUP, turnId: 't2' })
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect(JSON.stringify(await $.command.run({ command: 'tokens', args: '' }))).toContain('1 switches, 1 kept for the cache')
  })

  test('past the ceiling the loop still moves up when the work needs it', async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.turn.start({ text: LOOKUP, turnId: 't1' })
    await finish($.turn.step(STEP))
    s.tokens = 50_000
    await finish($.turn.step(STEP))
    s.tokens = 90_000
    await $.turn.start({ text: DESIGN, turnId: 't2' })
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'])
  })

  test('a prompt that could move nothing is not classified', async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.turn.start({ text: DESIGN, turnId: 't1' })
    await finish($.turn.step(STEP))
    s.tokens = 50_000
    await finish($.turn.step(STEP))
    s.tokens = 90_000
    await $.turn.start({ text: LOOKUP, turnId: 't2' })
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
    expect(s.asked).toHaveLength(1)
  })

  test('a model picked by hand ends routing for the session', async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.turn.start({ text: LOOKUP, turnId: 't1' })
    await finish($.turn.step(STEP))
    await $.turn.start({ text: LOOKUP, turnId: 't2' })
    await finish($.turn.step({ ...STEP, model: 'claude-fable-5-2' }))
    await $.turn.start({ text: LOOKUP, turnId: 't3' })
    await finish($.turn.step({ ...STEP, model: 'claude-fable-5-2' }))
    expect(s.requests).toEqual(['claude-haiku-5-5', 'claude-fable-5-2', 'claude-fable-5-2'])
    expect(s.asked).toHaveLength(1)
  })

  test('the quota guard holds heavy work to the standard model', async ($, on) => {
    const s = session(on, 75)
    await $.session.start(START)
    await $.turn.start({ text: DESIGN, turnId: 't1' })
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-sonnet-5-5'])
  })

  test("a subagent's requests are left alone", async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.turn.start({ text: LOOKUP, turnId: 't1' })
    await finish($.turn.step({ ...STEP, agentId: 'a1' }))
    expect(s.requests).toEqual(['claude-opus-5-5'])
  })

  test('the tier models are the person’s to set', { options: { lightModel: 'claude-haiku-4-5' } }, async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.turn.start({ text: LOOKUP, turnId: 't1' })
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-haiku-4-5'])
  })

  test('with routing off every request keeps its model', { options: { route: false } }, async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.turn.start({ text: LOOKUP, turnId: 't1' })
    await finish($.turn.step(STEP))
    expect(s.requests).toEqual(['claude-opus-5-5'])
    expect(s.asked).toEqual([])
  })
})

describe('routing subagents', () => {
  test('an agent type gets the model of its tier', async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    for (const subagent_type of ['Explore', 'general-purpose', 'Plan']) await $.tool.call({ ...AGENT, subagent_type })
    expect(s.agents).toEqual(['haiku', 'sonnet', 'opus'])
  })

  test('a call that names a model, an unlisted type and a call with no type are left alone', async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.tool.call({ ...AGENT, subagent_type: 'Plan', model: 'haiku' })
    await $.tool.call({ ...AGENT, subagent_type: 'token-optimiser:scout' })
    await $.tool.call(AGENT)
    expect(s.agents).toEqual(['haiku', undefined, undefined])
  })

  test('a table from the options replaces the built-in one and finds a plugin agent by its bare name', { options: { subagentTiers: '{"egm-design":"heavy"}' } }, async ($, on) => {
    const s = session(on)
    await $.session.start(START)
    await $.tool.call({ ...AGENT, subagent_type: 'egm:egm-design' })
    await $.tool.call({ ...AGENT, subagent_type: 'Explore' })
    expect(s.agents).toEqual(['opus', undefined])
  })

  test('the quota guard applies to subagents', async ($, on) => {
    const s = session(on, 95)
    await $.session.start(START)
    await $.tool.call({ ...AGENT, subagent_type: 'Plan' })
    expect(s.agents).toEqual(['haiku'])
  })
})
