// Which MCP tools were called, and when, read from omp's own session files. The first read is the slow one; each file's
// result is kept beside the settings, keyed by its size and modification time, so later reads scan only what changed.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { isRecord } from '../core/router'
import { SESSIONS_DIR } from './sessions'

/** MCP tool name to the last time (epoch ms) it was called in one file. */
export type ToolUse = Record<string, number>

interface Cached {
  size: number
  mtime: number
  use: ToolUse
}

const MCP_CALL = /"mcp__|xd:\/\/mcp__/ // a cheap test before a line is parsed
const XD_TOOL = /^xd:\/\/(mcp__[A-Za-z0-9_]+)/

/** The MCP tools called in one session file's text. A call is a tool call by name, or a path on the `xd://` tool device. */
export function toolUse(text: string): ToolUse {
  const use: ToolUse = {}
  for (const line of text.split('\n')) {
    if (!MCP_CALL.test(line)) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue // a half-written last line
    }
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message) || entry.message.role !== 'assistant') continue
    const at = Date.parse(String(entry.timestamp ?? ''))
    if (!Number.isFinite(at) || !Array.isArray(entry.message.content)) continue
    for (const block of entry.message.content) {
      if (!isRecord(block) || block.type !== 'toolCall') continue
      const target = typeof block.name === 'string' && block.name.startsWith('mcp__')
        ? block.name
        : isRecord(block.arguments) && typeof block.arguments.path === 'string'
          ? XD_TOOL.exec(block.arguments.path)?.[1]
          : undefined
      if (target) use[target] = Math.max(use[target] ?? 0, at)
    }
  }
  return use
}

export interface Usage {
  /** MCP tool name to the last time it was called. */
  lastUsed: Map<string, number>
  /** False when time ran out before every session file was read: a call may be missing, so nothing should be switched off on it. */
  complete: boolean
}

/**
 * MCP tool use over every session on disk. `cachePath` holds each file's result; `budgetMs` stops a first read that
 * runs long (what was read is kept, and the next session carries on).
 */
export function readUsage(cachePath: string, budgetMs: number, dir: string = SESSIONS_DIR): Usage {
  let cache: Record<string, Cached> = {}
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (isRecord(raw) && isRecord(raw.files)) cache = raw.files as Record<string, Cached>
  } catch {
    /* no cache yet */
  }
  const next: Record<string, Cached> = {}
  const lastUsed = new Map<string, number>()
  const stop = Date.now() + budgetMs
  let dirty = false
  let complete = true
  for (const file of sessionFilesUnder(dir)) {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    let entry = cache[file]
    if (!entry || entry.size !== stat.size || entry.mtime !== stat.mtimeMs) {
      if (Date.now() > stop) {
        complete = false // out of time: this file waits for the next session
        continue
      }
      try {
        entry = { size: stat.size, mtime: stat.mtimeMs, use: toolUse(fs.readFileSync(file, 'utf8')) }
      } catch {
        continue
      }
      dirty = true
    }
    next[file] = entry
    for (const [tool, at] of Object.entries(entry.use)) lastUsed.set(tool, Math.max(lastUsed.get(tool) ?? 0, at))
  }
  if (dirty || Object.keys(next).length !== Object.keys(cache).length) {
    try {
      fs.writeFileSync(cachePath, JSON.stringify({ files: next }))
    } catch {
      /* a cache that cannot be written only costs the next read */
    }
  }
  return { lastUsed, complete }
}

/** Every `.jsonl` under `dir`, at any depth: a subagent's session sits in a folder beside its parent's file. */
function sessionFilesUnder(dir: string): string[] {
  const files: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sessionFilesUnder(full))
    else if (entry.name.endsWith('.jsonl')) files.push(full)
  }
  return files
}
