import { describe, expect, test } from 'bun:test'

import { DEFAULT_MCP, emptyState, listServer, modelNote, normalise, planTrim, recordPrompt, report, restore, staysOn, summary } from './mcp'
import type { McpState, ToolInfo } from './mcp'

const tool = (name: string, mcpServerName?: string): ToolInfo => ({ name, mcpServerName })
const tools: ToolInfo[] = [tool('read'), tool('docs_search', 'acme-docs'), tool('docs_get', 'acme-docs'), tool('wiki_page', 'wiki')]
const loaded = ['docs_search', 'docs_get', 'wiki_page']

/** The state after `sessions` sessions of `prompts` prompts each, with `calls` on record. */
const after = (sessions: number, prompts: number, calls: Record<string, number> = {}, from: McpState = emptyState()): McpState => {
  let state = from
  for (let s = 0; s < sessions; s++) for (let p = 0; p < prompts; p++) state = recordPrompt(state, loaded, new Map(Object.entries(calls)), p === 0)
  return state
}

describe('recordPrompt', () => {
  test('counts a prompt for every loaded tool and a session on the first prompt only', () => {
    expect(after(2, 3).tools.docs_get).toEqual({ prompts: 6, sessions: 2 })
  })

  test('a call on record marks the tool as used and keeps the latest time', () => {
    const state = recordPrompt(after(1, 1, { docs_get: 5 }), loaded, new Map([['docs_get', 3], ['gone_tool', 9]]), false)
    expect(state.tools.docs_get.used).toBe(5)
    expect(state.tools.gone_tool).toEqual({ prompts: 0, sessions: 0, used: 9 })
  })
})

describe('the rule', () => {
  const offOf = (state: McpState, policy = DEFAULT_MCP) => planTrim(tools, state, policy).flatMap(s => s.off).sort()

  test('nothing is off without evidence', () => {
    expect(offOf(emptyState())).toEqual([])
    expect(offOf(after(1, 30))).toEqual([]) // one long session is one session
    expect(offOf(after(4, 1))).toEqual([]) // four short ones are neither ten prompts nor five sessions
  })

  test('ten prompts across two sessions, or five sessions, switch an uncalled tool off', () => {
    expect(offOf(after(2, 5))).toEqual(['docs_get', 'docs_search', 'wiki_page'])
    expect(offOf(after(5, 1))).toEqual(['docs_get', 'docs_search', 'wiki_page'])
  })

  test('a tool that was ever called stays on, whatever the evidence since', () => {
    expect(offOf(after(9, 9, { docs_search: 1 }))).toEqual(['docs_get', 'wiki_page'])
  })

  test('keep and restore hold a tool or a whole server on, whatever the spelling', () => {
    const state = after(5, 1)
    expect(offOf(state, { ...DEFAULT_MCP, keep: ['Acme_Docs'] })).toEqual(['wiki_page'])
    expect(offOf(state, { ...DEFAULT_MCP, keep: ['wiki-page'] })).toEqual(['docs_get', 'docs_search'])
    expect(offOf(restore(state, 'acme docs', tools)!)).toEqual(['wiki_page'])
  })

  test('propose plans the same tools as auto; off plans none', () => {
    expect(offOf(after(5, 1), { ...DEFAULT_MCP, trim: 'propose' })).toHaveLength(3)
    expect(offOf(after(5, 1), { ...DEFAULT_MCP, trim: 'off' })).toEqual([])
  })

  test('a tool that is not an MCP tool is never in the plan', () => {
    const state = recordPrompt(emptyState(), ['read'], new Map(), true)
    expect(planTrim(tools, { ...state, tools: { read: { prompts: 99, sessions: 99 } } }, DEFAULT_MCP).flatMap(s => [...s.on, ...s.off])).not.toContain('read')
  })

  test('each tool carries the reason it stays on', () => {
    expect(staysOn(tools[1], after(1, 3), DEFAULT_MCP)).toBe('not enough evidence yet (3 prompts over 1 sessions without a call)')
    expect(staysOn(tools[1], after(5, 1, { docs_search: 1 }), DEFAULT_MCP)).toBe('has been called')
    expect(staysOn(tools[1], after(5, 1), DEFAULT_MCP)).toBeUndefined()
  })
})

describe('restore', () => {
  test('names a connected server or tool, once; anything else is refused', () => {
    const state = restore(emptyState(), 'WIKI', tools)!
    expect(state.restored).toEqual(['wiki'])
    expect(restore(state, 'wiki', tools)).toBe(state)
    expect(restore(emptyState(), 'docs-get', tools)!.restored).toEqual(['docs_get'])
    expect(restore(emptyState(), 'no-such-server', tools)).toBeUndefined()
  })
})

describe('what is said', () => {
  const state = after(5, 1, { docs_search: Date.UTC(2026, 10, 20) })
  const plan = planTrim(tools, state, DEFAULT_MCP)

  test('the session line counts the tools and names the way back', () => {
    expect(summary(plan, DEFAULT_MCP)).toBe('2 of 3 MCP tools are off for this session: never called. /tokens-mcp lists them; /tokens-mcp restore <server or tool> gives one back')
    expect(summary(plan, { ...DEFAULT_MCP, trim: 'propose' })).toContain('could be switched off')
    expect(summary(planTrim(tools, emptyState(), DEFAULT_MCP), DEFAULT_MCP)).toBeUndefined()
  })

  test('the model is told which servers have tools off, and nothing when none are', () => {
    expect(modelNote(plan)).toContain('acme-docs (1), wiki (1)')
    expect(modelNote(planTrim(tools, emptyState(), DEFAULT_MCP))).toBeUndefined()
  })

  test('the report gives each server its counts, the rule and the restored list', () => {
    const text = report(plan, { ...state, restored: ['wiki'] }, DEFAULT_MCP, Date.UTC(2026, 10, 21))
    expect(text).toContain('acme-docs')
    expect(text).toContain('last call 1d ago')
    expect(text).toContain('2 servers, 3 tools; 2 off')
    expect(text).toContain('over 10 prompts in 2 or more sessions, or over 5 sessions')
    expect(text).toContain('Restored, never switched off again: wiki.')
  })

  test('a server listing gives every tool its reason', () => {
    expect(listServer('Acme Docs', tools, state, DEFAULT_MCP)).toBe('docs_search: has been called\ndocs_get: off, loaded and never called over 10 prompts in 2 or more sessions, or over 5 sessions')
    expect(listServer('nope', tools, state, DEFAULT_MCP)).toBeUndefined()
  })
})

test('a server or tool name matches whatever its case and separators', () => {
  expect(normalise('Acme-Docs')).toBe(normalise('acme docs'))
})
