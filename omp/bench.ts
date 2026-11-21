// How well, how steadily and how fast the light model reads prompts, beside the rules it falls back on.
// Each prompt is read RUNS times. Run inside omp, on your own login (54 small requests, well under a cent):
//
//   omp --no-extensions -e ./omp/bench.ts -p go
//
// The expected tiers are the author's judgement: a smoke test of the classifier, not a benchmark of the model.
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'

import { CLASSIFIER_SYSTEM, classifierPrompt, classify, parseTier } from '../core/router'
import type { Tier } from '../core/router'
import { DEFAULT_CONFIG, textOf } from './router'

const RUNS = 3

interface Case {
  prompt: string
  /** The end of the assistant's reply before the prompt, for a follow-up. */
  after?: string
  expected: Tier
}

const CASES: Case[] = [
  { prompt: 'what does parse_args return?', expected: 'light' },
  { prompt: 'commit this', expected: 'light' },
  { prompt: 'rename foo to bar in utils.ts', expected: 'light' },
  { prompt: 'run the tests', expected: 'light' },
  { prompt: 'which file defines the Router class?', expected: 'light' },
  { prompt: 'add a --dry-run flag to deploy.sh and update its test', expected: 'standard' },
  { prompt: 'fix the off-by-one in paginate() and add a test', expected: 'standard' },
  { prompt: 'add an endpoint GET /users/:id/orders with pagination', expected: 'standard' },
  { prompt: 'write a unit test for the date parser', expected: 'standard' },
  { prompt: 'the build fails with TS2345 in api.ts, fix it', expected: 'standard' },
  { prompt: 'design the migration of the queue across all services, trade-offs please', expected: 'heavy' },
  { prompt: 'Investigate why the nightly sync intermittently loses rows and find the root cause', expected: 'heavy' },
  { prompt: 'review the auth flow for security holes', expected: 'heavy' },
  { prompt: 'we need to split the monolith; propose an architecture', expected: 'heavy' },
  { prompt: 'yes, do it', after: 'I can redesign the storage layer around an event log; it touches every service. Shall I go ahead?', expected: 'heavy' },
  { prompt: 'yes, do it', after: 'The typo is in README.md line 3. Shall I fix it?', expected: 'light' },
  { prompt: 'continue', after: 'I have added the flag to deploy.sh; next is its test. Continue?', expected: 'standard' },
  { prompt: 'ok go', after: 'Plan: 1) find the race in the scheduler 2) prove it with a failing test 3) fix the locking. Start?', expected: 'heavy' },
]

export default function (pi: ExtensionAPI) {
  pi.on('before_agent_start', async (_event, ctx: ExtensionContext) => {
    // omp's own model client, on the session's login. It exists only inside omp, so it is loaded here, not at the top.
    const { completeSimple } = await import('@oh-my-pi/pi-ai')
    const model = ctx.models.resolve(DEFAULT_CONFIG.tiers.light)
    if (!model) throw new Error(`${DEFAULT_CONFIG.tiers.light} is not available on this login`)
    const apiKey = await ctx.modelRegistry.getApiKey(model)

    const times: number[] = []
    let cost = 0
    let right = 0
    let steady = 0
    let rulesRight = 0
    const misses: string[] = []
    for (const { prompt, after = '', expected } of CASES) {
      const readings: (Tier | undefined)[] = []
      for (let run = 0; run < RUNS; run++) {
        const started = Date.now()
        const answer = await completeSimple(
          model,
          { systemPrompt: CLASSIFIER_SYSTEM, messages: [{ role: 'user', content: classifierPrompt(prompt, after), timestamp: started }] },
          { apiKey, maxTokens: 8 },
        )
        times.push(Date.now() - started)
        cost += answer.usage.cost.total
        readings.push(parseTier(textOf(answer)))
      }
      const rules = classify(prompt).tier
      if (readings.every(tier => tier === expected)) right++
      if (readings.every(tier => tier === readings[0])) steady++
      if (rules === expected) rulesRight++
      if (rules !== expected || readings.some(tier => tier !== expected)) {
        misses.push(`  "${prompt}" expected ${expected}: model ${readings.join(', ')}; rules ${rules}`)
      }
    }
    times.sort((a, b) => a - b)

    console.log(
      [
        `${model.id}, ${CASES.length} prompts read ${RUNS} times each (${times.length} requests)`,
        `  expected tier every time:  model ${right} of ${CASES.length}, rules ${rulesRight} of ${CASES.length}`,
        `  same answer every time:    ${steady} of ${CASES.length}`,
        `  time per read:             median ${times[times.length >> 1]} ms, longest ${times.at(-1)} ms`,
        `  cost per read:             $${(cost / times.length).toFixed(6)}`,
        ...(misses.length ? ['misses:', ...misses] : []),
      ].join('\n'),
    )
    process.exit(0) // the benchmark is the whole run; the prompt itself is never sent
  })
}
