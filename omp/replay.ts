// Replays the main-loop turns of your own omp sessions under different routing policies, to price the rule in core/router.ts.
//
//   bun omp/replay.ts [--days 30] [--until 2026-11-21] [--ttl 3600] [--dir ~/.omp/agent/sessions]
//
// Each turn is a user prompt and the assistant requests that followed it. A turn is read by the core's fixed rules (not the
// light model), so most turns come out `standard`. Each policy picks a model per turn; the turn's recorded requests are then
// priced on that model, with a prompt cache per model that expires `ttl` seconds after its last use. Assumes the cheaper
// model makes the same requests and writes the same output. An estimate, not a bill: `baseline` says how close the
// pricing is, as the replay of the models actually used over what the sessions were billed (it should be near 1.00).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { classify } from '../core/router'
import type { Tier } from '../core/router'

interface Price {
  in: number
  out: number
  read: number
}

/** $ per million tokens, as in omp's catalog. A cache write costs `in` x 2 for a one-hour entry, x 1.25 for a five-minute one. */
const PRICES: Record<string, Price> = {
  'claude-fable-5-2': { in: 8, out: 40, read: 0.2 },
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.1 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01 },
}
/** Haiku 5.5 is dearer for a request whose input passes 100,000 tokens. */
const HAIKU_LONG: Price = { in: 0.5, out: 2.5, read: 0.05 }
const TIER_MODEL: Record<Tier, string> = { light: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', heavy: 'claude-opus-5-5' }
/** Cheapest first. */
const RANK = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback
}
const DAYS = Number(arg('days', '30'))
const UNTIL = Date.parse(arg('until', new Date().toISOString()))
const TTL_MS = Number(arg('ttl', '3600')) * 1000
const DIR = arg('dir', path.join(os.homedir(), '.omp', 'agent', 'sessions'))
const WRITE_FACTOR = TTL_MS >= 3_600_000 ? 2 : 1.25

interface Request {
  at: number
  model: string
  input: number
  output: number
  read: number
  write: number
  billed: number
}
interface Turn {
  tier: Tier
  requests: Request[]
}
/** What a model still has cached: when it was last used and how much context it held. */
type Caches = Map<string, { at: number; tokens: number }>
/** The model a turn runs on, given the one the loop is on and what each model has cached. */
type Policy = (turn: Turn, current: string, caches: Caches) => string

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

function sessionTurns(file: string): Turn[] {
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
    } else if (m.role === 'assistant' && m.usage && m.model && PRICES[m.model] && turns.length) {
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

function loadSessions(): Turn[][] {
  const since = UNTIL - DAYS * 86_400_000
  const sessions: Turn[][] = []
  for (const dir of fs.readdirSync(DIR)) {
    const folder = path.join(DIR, dir)
    if (!fs.statSync(folder).isDirectory()) continue
    for (const name of fs.readdirSync(folder)) {
      const file = path.join(folder, name)
      const modified = fs.statSync(file).mtimeMs
      if (name.endsWith('.jsonl') && modified >= since && modified <= UNTIL) sessions.push(sessionTurns(file))
    }
  }
  return sessions.filter(s => s.length)
}

/** What a turn's requests cost on `model`; the first request reads whatever that model still has cached. */
function turnCost(requests: Request[], model: string, caches: Caches): number {
  let cost = 0
  requests.forEach((q, i) => {
    const prefix = q.read + q.write
    const p = model === 'claude-haiku-5-5' && q.input + prefix > 100_000 ? HAIKU_LONG : PRICES[model]!
    let read = q.read
    if (i === 0) {
      const had = caches.get(model)
      read = had && q.at - had.at <= TTL_MS ? Math.min(had.tokens, prefix) : 0
    }
    cost += (q.input * p.in + q.output * p.out + read * p.read + (prefix - read) * p.in * WRITE_FACTOR) / 1e6
    caches.set(model, { at: q.at, tokens: q.input + prefix })
  })
  return cost
}

function run(sessions: Turn[][], policy: Policy): { total: number; moves: number } {
  let total = 0
  let moves = 0
  for (const turns of sessions) {
    const caches: Caches = new Map()
    let current = turns[0]!.requests[0]!.model
    for (const turn of turns) {
      const model = policy(turn, current, caches)
      if (model !== current) moves++
      current = model
      total += turnCost(turn.requests, model, caches)
    }
  }
  return { total, moves }
}

const recorded = (turn: Turn): string => turn.requests[0]!.model
const cheaper = (a: string, b: string): boolean => RANK.indexOf(a) < RANK.indexOf(b)

/** Every turn on the model it was recorded on. */
const actual: Policy = recorded
/** What the router does: every turn on its tier's model. */
const followTier: Policy = turn => TIER_MODEL[turn.tier]
/** Only ever a cheaper model than the one recorded; heavy work stays where it ran. */
const downOnly: Policy = turn => (cheaper(TIER_MODEL[turn.tier], recorded(turn)) ? TIER_MODEL[turn.tier] : recorded(turn))
/** With hindsight: for each turn, the cheapest of the models that are the recorded one or at least as strong as the tier's. */
const hindsight: Policy = (turn, current, caches) => {
  const options = [...new Set([current, recorded(turn), downOnly(turn, current, caches)])].filter(m => m === recorded(turn) || !cheaper(m, TIER_MODEL[turn.tier]))
  return options.reduce((best, model) => (turnCost(turn.requests, model, new Map(caches)) < turnCost(turn.requests, best, new Map(caches)) ? model : best))
}

const sessions = loadSessions()
if (!sessions.length) throw new Error(`no omp sessions with assistant requests under ${DIR} in the ${DAYS} days to ${new Date(UNTIL).toISOString().slice(0, 10)}`)
const turns = sessions.flat()
const tiers = { light: 0, standard: 0, heavy: 0 }
for (const t of turns) tiers[t.tier]++
const billed = turns.reduce((sum, t) => sum + t.requests.reduce((s, q) => s + q.billed, 0), 0)
const base = run(sessions, actual)
const saved = (policy: Policy): string => {
  const r = run(sessions, policy)
  return `${((1 - r.total / base.total) * 100).toFixed(1)}% saved, ${r.moves} moves`
}

console.log(`${sessions.length} sessions, ${turns.length} turns in the ${DAYS} days to ${new Date(UNTIL).toISOString().slice(0, 10)}; cache ${TTL_MS / 1000}s`)
console.log(`turns by the rules: ${tiers.light} light, ${tiers.standard} standard, ${tiers.heavy} heavy`)
console.log(`baseline: replay of the models actually used / billed = ${(base.total / billed).toFixed(2)}`)
console.log(`follow the tier (what the router does): ${saved(followTier)}`)
console.log(`move down only, never up:               ${saved(downOnly)}`)
console.log(`hindsight, cheapest per turn:           ${saved(hindsight)}`)
