// Model routing for Claude Code: the model follows the job. The decisions are ../core/router.ts; this file is the engine's side.
//
//   Main loop: `turn.step` may name another model for a request. The turn's first step routes the person's prompt, and the
//     choice then holds until a later prompt changes it. A full model id is needed there; an alias is refused.
//   The prompt is read by the light model ($.model.complete, one small request), and by the core's rules when that fails.
//   Subagents: the Agent tool takes a model alias, added to a call that names none.
//   Quota: the engine reports the share of the 7-day limit used on a plan login; on an API key there is none, so nothing is held.
import type { EngineInterface, TurnStepInput } from 'claude-code'

import { CLASSIFIER_SYSTEM, DEFAULT_GUARD, classifierPrompt, classify, decide, parseSubagents, parseTier, subagentTier, tierOf } from '../core/router'
import type { Policy, Tier } from '../core/router'

export interface Routing extends Policy {
  /** Tier -> model id for the main loop. */
  models: Record<Tier, string>
}

/** The Agent tool's alias for each tier. */
const ALIAS = { light: 'haiku', standard: 'sonnet', heavy: 'opus' } as const satisfies Record<Tier, string>

// Claude Code's built-in agent types. A fork is never listed: it runs on its parent's context and cache.
const SUBAGENTS: Record<string, Tier> = { Explore: 'light', 'general-purpose': 'standard', Plan: 'heavy' }

/** One session's routing state. */
export interface Route {
  /** The person's prompt, until the turn's first step has routed it. */
  prompt: string
  /** The main loop's last answer: what a follow-up such as "yes, do it" refers to. */
  reply: string
  /** The tier the loop runs on; undefined while it runs on the session's own model. */
  tier?: Tier
  /** The session's model, as the engine last offered it. */
  offered?: string
  /** Set once the person changes model by hand: the router leaves the main loop alone from then on. */
  handsOff: boolean
  /** What the router did with the last prompt, and why. */
  last?: string
  switches: number
  subagents: number
}

export const newRoute = (): Route => ({ prompt: '', reply: '', handsOff: false, switches: 0, subagents: 0 })

/** The routing a person's options ask for; undefined when routing is switched off. */
export function routingFrom(options: Readonly<Record<string, unknown>>): Routing | undefined {
  if (options.route === false) return undefined
  const text = (key: string, fallback: string) => String(options[key] ?? '').trim() || fallback
  const positive = (key: string, fallback: number) => (Number(options[key]) > 0 ? Number(options[key]) : fallback)
  return {
    models: {
      light: text('lightModel', 'claude-haiku-5-5'),
      standard: text('standardModel', 'claude-sonnet-5-5'),
      heavy: text('heavyModel', 'claude-opus-5-5'),
    },
    quotaGuard: {
      enabled: true,
      holdHeavyAt: positive('holdHeavyAtPercent', DEFAULT_GUARD.holdHeavyAt * 100) / 100,
      lightOnlyAt: positive('lightOnlyAtPercent', DEFAULT_GUARD.lightOnlyAt * 100) / 100,
    },
    subagents: parseSubagents(options.subagentTiers) ?? SUBAGENTS,
  }
}

/** What the router reads of $.session.usage(). Before a session's first request there are no limits yet. */
interface Usage {
  rateLimits: readonly { kind: string; percentUsed: number }[]
}

/** Share of the 7-day limit used, 0..1; undefined on an API key, which has none. */
async function quotaUsed($: EngineInterface): Promise<number | undefined> {
  const usage: Usage | undefined = await $.session.usage().catch(() => undefined)
  const week = usage?.rateLimits.find(limit => limit.kind === 'seven_day')
  return week && week.percentUsed / 100
}

/** The light model's reading of a prompt; undefined when it gave none in time. */
async function asked($: EngineInterface, model: string, prompt: string, reply: string): Promise<Tier | undefined> {
  const answer = await $.model
    .complete({ model, system: CLASSIFIER_SYSTEM, prompt: classifierPrompt(prompt, reply), maxTokens: 8, timeoutMs: 5_000 })
    .catch(() => undefined)
  return answer?.isAnswered ? parseTier(answer.text) : undefined
}

/** The model for one request of the main loop. */
export async function mainModel($: EngineInterface, e: TurnStepInput, r: Route, cfg: Routing): Promise<string> {
  // The engine offers the session's model on every step. A different one is the person's /model: theirs to keep.
  if (r.offered !== undefined && e.model !== r.offered) r.handsOff = true
  r.offered = e.model
  if (r.handsOff) return e.model

  const current = r.tier ? cfg.models[r.tier] : e.model
  const prompt = r.prompt
  r.prompt = ''
  if (prompt === '') return current

  const now = { quotaUsed: await quotaUsed($), current: r.tier ?? tierOf(e.model, cfg.models) }
  const read = await asked($, cfg.models.light, prompt, r.reply)
  const { tier, action, why } = decide(read ?? classify(prompt).tier, now, cfg)
  r.last = `${why} (read by ${read ? 'the light model' : 'the rules'})`
  if (action !== 'switch') return current
  r.tier = tier
  r.switches++
  $.ui.toast(`token-optimiser: ${cfg.models[tier]} (${tier})`)
  return cfg.models[tier]
}

/** The model alias for an Agent call, by the agent's type; undefined leaves the call as it is. */
export async function agentModel($: EngineInterface, agent: string | undefined, r: Route, cfg: Routing): Promise<(typeof ALIAS)[Tier] | undefined> {
  const choice = subagentTier(agent, await quotaUsed($), cfg)
  if (!choice) return undefined
  r.subagents++
  return ALIAS[choice.tier]
}

/** The routing line of the /tokens report. */
export function routeLine(r: Route, cfg: Routing | undefined): string {
  if (!cfg) return '  routing: off'
  const loop = r.handsOff ? 'your /model choice (routing stopped for this session)' : r.tier ? `${cfg.models[r.tier]} (${r.tier})` : "the session's model"
  const last = r.last ? `\n  last prompt: ${r.last}` : ''
  return `  routing: main loop on ${loop}; ${r.switches} switches, ${r.subagents} subagents routed${last}`
}
