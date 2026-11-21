// Reads omp's own session files (~/.omp/agent/sessions/<project>/<session>.jsonl) into turns. Shared by replay.ts and cost.ts.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { classify } from '../core/router'
import type { Tier } from '../core/router'

export const SESSIONS_DIR = path.join(os.homedir(), '.omp', 'agent', 'sessions')

/** One request to a model, with what it was billed (omp's own figure, at API list prices). */
export interface Request {
  at: number
  model: string
  input: number
  output: number
  read: number
  write: number
  billed: number
}

/** A user prompt, the tier the core's fixed rules give it, and the requests that followed it. */
export interface Turn {
  tier: Tier
  requests: Request[]
}

/** The parts of a session file's `message` entries that are read here. */
interface Entry {
  type?: string
  timestamp?: string
  message?: {
    role?: string
    model?: string
    content?: string | { type?: string; text?: string }[]
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
  }
}

const textOf = (content: NonNullable<Entry['message']>['content']): string =>
  typeof content === 'string' ? content : (content ?? []).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join(' ')

/** The turns of one session file; a turn with no request is left out. */
export function sessionTurns(file: string): Turn[] {
  const turns: Turn[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry // a session file is omp's own output
    } catch {
      continue // a half-written last line
    }
    const m = entry?.message
    if (entry?.type !== 'message' || !m) continue
    if (m.role === 'user') {
      turns.push({ tier: classify(textOf(m.content)).tier, requests: [] })
    } else if (m.role === 'assistant' && m.usage && m.model && turns.length) {
      const u = m.usage
      turns.at(-1)!.requests.push({
        at: Date.parse(entry.timestamp ?? ''),
        model: m.model,
        input: u.input ?? 0,
        output: u.output ?? 0,
        read: u.cacheRead ?? 0,
        write: u.cacheWrite ?? 0,
        billed: u.cost?.total ?? 0,
      })
    }
  }
  return turns.filter(t => t.requests.length)
}

/** The session files in `dir` last written between `since` and `until` (epoch ms), one folder deep. */
export function sessionFiles(dir: string, since: number, until: number): string[] {
  const files: string[] = []
  for (const project of fs.readdirSync(dir)) {
    const folder = path.join(dir, project)
    if (!fs.statSync(folder).isDirectory()) continue
    for (const name of fs.readdirSync(folder)) {
      const file = path.join(folder, name)
      const modified = fs.statSync(file).mtimeMs
      if (name.endsWith('.jsonl') && modified >= since && modified <= until) files.push(file)
    }
  }
  return files
}
