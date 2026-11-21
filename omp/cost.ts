// What your omp sessions cost, by window, for a before/after comparison of the router.
//
//   bun omp/cost.ts [--dir ~/.omp/agent/sessions]
//
// Prints each window below: requests, turns, what omp billed (its own figure, at API list prices, whatever the login pays),
// the cost per turn and per request, the median context a request carried, the share of cost by model, and a price index.
// The index is the billed cost over what the same tokens would have cost on Opus 5.5 (a one-hour cache write at twice its
// input price): 1.00 is all Opus, lower is a cheaper mix of models. It does not depend on how long the sessions ran or how
// large their contexts grew, which is why it is the figure to compare. A turn is a user prompt and the requests after it,
// placed in the window of its first request.
//
// The windows are fixed, so a later run reproduces an earlier one on the same sessions:
//   before   no router at all (29 Oct 2026 to the first prompt the earlier regex router saw, 12 Nov 13:39:40 UTC)
//   interim  that regex router, which held the model past 30,000 tokens of context and so mostly kept it
//   after    token-optimiser 0.6.0, which follows the prompt's tier at any context size (first move 21 Nov 12:15:16 UTC)
//
// Not a controlled comparison: the work differs from window to window (the `before` window is mostly long unattended runs,
// which is why it has so few turns), so compare the index, not the cost per turn, and let the windows grow before drawing a
// conclusion. It reads only this machine's sessions.
import { SESSIONS_DIR, sessionFiles, sessionTurns } from './sessions'
import type { Turn } from './sessions'

interface Window {
  name: string
  from: string
  to: string
  note: string
}

export const WINDOWS: readonly Window[] = [
  { name: 'before', from: '2026-10-29T00:00:00Z', to: '2026-11-12T13:39:40Z', note: 'no router' },
  { name: 'interim', from: '2026-11-12T13:39:40Z', to: '2026-11-21T12:15:16Z', note: 'regex router, 30,000-token ceiling' },
  { name: 'after', from: '2026-11-21T12:15:16Z', to: '9999-12-31T00:00:00Z', note: 'token-optimiser 0.6.0' },
]

/** Opus 5.5's $ per million tokens, in the catalog's terms; a cache write is two times input (a one-hour entry). */
const OPUS = { input: 4, output: 20, read: 0.2, write: 8 }

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)]! : 0
}

export interface Summary {
  requests: number
  turns: number
  billed: number
  perTurn: number
  perRequest: number
  medianContext: number
  /** Billed over the cost of the same tokens on Opus 5.5. */
  index: number
  share: Record<string, number>
}

/** The turns whose first request falls in [from, to). */
export function summarise(turns: readonly Turn[], from: number, to: number): Summary {
  const inside = turns.filter(t => t.requests[0]!.at >= from && t.requests[0]!.at < to)
  const requests = inside.flatMap(t => t.requests)
  const billed = requests.reduce((sum, q) => sum + q.billed, 0)
  const onOpus = requests.reduce((sum, q) => sum + (q.input * OPUS.input + q.output * OPUS.output + q.read * OPUS.read + q.write * OPUS.write) / 1e6, 0)
  const byModel: Record<string, number> = {}
  for (const q of requests) byModel[q.model] = (byModel[q.model] ?? 0) + q.billed
  const share = Object.fromEntries(Object.entries(byModel).map(([model, cost]) => [model, billed ? cost / billed : 0]))
  return {
    requests: requests.length,
    turns: inside.length,
    billed,
    perTurn: inside.length ? billed / inside.length : 0,
    perRequest: requests.length ? billed / requests.length : 0,
    medianContext: median(requests.map(q => q.input + q.read + q.write)),
    index: onOpus ? billed / onOpus : 0,
    share,
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--dir')
  const dir = at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : SESSIONS_DIR
  const turns = sessionFiles(dir, Date.parse(WINDOWS[0]!.from), Infinity).flatMap(sessionTurns)
  for (const w of WINDOWS) {
    const s = summarise(turns, Date.parse(w.from), Date.parse(w.to))
    const shares = Object.entries(s.share)
      .sort((a, b) => b[1] - a[1])
      .map(([model, x]) => `${model.replace('claude-', '')} ${(x * 100).toFixed(0)}%`)
      .join(', ')
    console.log(`${w.name} (${w.note}), ${w.from.slice(0, 16)} to ${w.to.startsWith('9999') ? 'now' : w.to.slice(0, 16)}`)
    console.log(`  ${s.turns} turns, ${s.requests} requests, billed $${s.billed.toFixed(2)}`)
    console.log(`  $${s.perTurn.toFixed(3)} per turn, $${s.perRequest.toFixed(4)} per request, median context ${Math.round(s.medianContext / 1000)}k tokens`)
    console.log(`  price index ${s.index.toFixed(2)} (1.00 = every token on Opus 5.5)`)
    console.log(`  by model: ${shares || 'none'}`)
  }
}
