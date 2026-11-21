import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { readUsage, toolUse } from './usage'

const call = (at: string, block: object, role = 'assistant') =>
  JSON.stringify({ type: 'message', timestamp: at, message: { role, content: [{ type: 'toolCall', ...block }] } })

describe('toolUse', () => {
  test('reads a direct MCP tool call and a call through the xd:// device, keeping the latest time', () => {
    const text = [
      call('2026-11-10T10:00:00Z', { name: 'mcp__acme_search' }),
      call('2026-11-12T10:00:00Z', { name: 'mcp__acme_search' }),
      call('2026-11-11T10:00:00Z', { name: 'write', arguments: { path: 'xd://mcp__wiki_page_get', content: '{}' } }),
    ].join('\n')
    const use = toolUse(text)
    expect(use.mcp__acme_search).toBe(Date.parse('2026-11-12T10:00:00Z'))
    expect(use.mcp__wiki_page_get).toBe(Date.parse('2026-11-11T10:00:00Z'))
  })

  test('a mention in text, a tool result or a user message is not a call', () => {
    const text = [
      call('2026-11-10T10:00:00Z', { name: 'mcp__acme_search' }, 'user'),
      JSON.stringify({ type: 'message', timestamp: '2026-11-10T10:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'try "mcp__acme_search" or xd://mcp__acme_search' }] } }),
      JSON.stringify({ type: 'message', timestamp: '2026-11-10T10:00:00Z', message: { role: 'toolResult', content: 'xd://mcp__acme_search' } }),
      '{"type":"message","timestamp":"2026-11-10T10:00:00Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"mcp__half',
    ].join('\n')
    expect(toolUse(text)).toEqual({})
  })
})

describe('readUsage', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'to-usage-'))
    fs.mkdirSync(path.join(dir, 'proj', 'session-1'), { recursive: true })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test("reads every session file, a subagent's in its folder included, and keeps the latest call", () => {
    fs.writeFileSync(path.join(dir, 'proj', 'a.jsonl'), call('2026-11-20T10:00:00Z', { name: 'mcp__acme_search' }))
    fs.writeFileSync(path.join(dir, 'proj', 'session-1', 'child.jsonl'), [call('2026-11-21T10:00:00Z', { name: 'mcp__acme_search' }), call('2026-10-01T10:00:00Z', { name: 'mcp__wiki_page_get' })].join('\n'))
    const usage = readUsage(path.join(dir, 'cache.json'), 5_000, dir)
    expect(usage.complete).toBe(true)
    expect(usage.lastUsed).toEqual(new Map([['mcp__acme_search', Date.parse('2026-11-21T10:00:00Z')], ['mcp__wiki_page_get', Date.parse('2026-10-01T10:00:00Z')]]))
  })

  test('a second read takes unchanged files from the cache and reads a changed one again', () => {
    const file = path.join(dir, 'proj', 'a.jsonl')
    fs.writeFileSync(file, call('2026-11-20T10:00:00Z', { name: 'mcp__acme_search' }))
    const cache = path.join(dir, 'cache.json')
    readUsage(cache, 5_000, dir)
    const cached = JSON.parse(fs.readFileSync(cache, 'utf8'))
    cached.files[file].use = { mcp__from_cache: 1 } // a value the file itself could not give
    fs.writeFileSync(cache, JSON.stringify(cached))
    expect([...readUsage(cache, 5_000, dir).lastUsed.keys()]).toEqual(['mcp__from_cache'])
    fs.appendFileSync(file, '\n' + call('2026-11-21T10:00:00Z', { name: 'mcp__wiki_page_get' }))
    expect([...readUsage(cache, 5_000, dir).lastUsed.keys()].sort()).toEqual(['mcp__acme_search', 'mcp__wiki_page_get'])
  })

  test('out of time, the read says it is incomplete and the next read finishes it', () => {
    fs.writeFileSync(path.join(dir, 'proj', 'a.jsonl'), call('2026-11-20T10:00:00Z', { name: 'mcp__acme_search' }))
    const cache = path.join(dir, 'cache.json')
    expect(readUsage(cache, -1, dir)).toEqual({ lastUsed: new Map(), complete: false })
    expect(readUsage(cache, 5_000, dir).lastUsed.size).toBe(1)
  })

  test('no sessions at all is no use', () => {
    expect(readUsage(path.join(dir, 'cache.json'), 5_000, path.join(dir, 'missing'))).toEqual({ lastUsed: new Map(), complete: true })
  })
})
