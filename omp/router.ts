// token-optimiser for omp: the model follows the job. The decisions are ../core/router.ts; this file is omp's side of them.
//
//   1. Subagents (before_subagent_spawn): a child starts with an empty context, so its model costs no cache to choose.
//   2. Main loop (before_agent_start): the light model reads the prompt (the core's rules when it cannot) and the model follows.
//      Any move while the context is small (a new session, or right after a compaction or handoff); past that only up, since a
//      move down would abandon a prompt cache worth more than it saves. A model the person picks by hand (/model) is never
//      touched again in that session.
//   3. Quota guard: as the 7-day Claude quota (`omp usage`) runs out, heavy work drops to the standard model, then all of it to light.
//
// Thinking effort is omp's own (`ultrathink` and `chillax` steer it); nothing here changes it.
// Settings: ~/.omp/agent/token-optimiser.json, read on every prompt, so an edit applies at once. Log: token-optimiser.jsonl beside it.
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { CLASSIFIER_SYSTEM, DEFAULT_CEILING, DEFAULT_GUARD, TIERS, baselineOf, classifierPrompt, classify, decide, isRecord, openTiers, parseSubagents, parseTier, subagentTier, tierOf } from '../core/router'
import type { Policy, Tier } from '../core/router'

export interface RouterConfig extends Policy {
  enabled: boolean
  /** Tier -> model, as `provider/id`. */
  tiers: Record<Tier, string>
  /**
   * MCP server -> pattern (a case-insensitive regular expression). When a prompt matches and the server is switched off in
   * mcp.json, the router says once per session how to turn it on. Empty by default: see examples/omp-config.json.
   */
  mcpHints: Record<string, string>
}

export const DEFAULT_CONFIG: RouterConfig = {
  enabled: true,
  tiers: {
    light: 'anthropic/claude-haiku-5-5',
    standard: 'anthropic/claude-sonnet-5-5',
    heavy: 'anthropic/claude-opus-5-5',
  },
  contextCeilingTokens: DEFAULT_CEILING,
  quotaGuard: DEFAULT_GUARD,
  // Search and read agents are light, general task agents standard, the ones that judge heavy.
  subagents: {
    scout: 'light',
    explore: 'light',
    sonic: 'light',
    task: 'standard',
    reviewer: 'heavy',
    'security-reviewer': 'heavy',
    plan: 'heavy',
  },
  mcpHints: {},
}

/** A person's JSON over the defaults; anything of the wrong shape is ignored. A `subagents` table replaces the default one. */
export function mergeConfig(raw: unknown): RouterConfig {
  const out = structuredClone(DEFAULT_CONFIG)
  if (!isRecord(raw)) return out
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (isRecord(raw.tiers)) {
    for (const tier of TIERS) {
      const model = raw.tiers[tier]
      if (typeof model === 'string' && model) out.tiers[tier] = model
    }
  }
  if (typeof raw.contextCeilingTokens === 'number' && raw.contextCeilingTokens > 0) out.contextCeilingTokens = raw.contextCeilingTokens
  if (isRecord(raw.quotaGuard)) {
    const q = raw.quotaGuard
    if (typeof q.enabled === 'boolean') out.quotaGuard.enabled = q.enabled
    if (typeof q.holdHeavyAt === 'number') out.quotaGuard.holdHeavyAt = q.holdHeavyAt
    if (typeof q.lightOnlyAt === 'number') out.quotaGuard.lightOnlyAt = q.lightOnlyAt
  }
  out.subagents = parseSubagents(raw.subagents) ?? out.subagents
  if (isRecord(raw.mcpHints)) {
    out.mcpHints = Object.fromEntries(Object.entries(raw.mcpHints).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }
  return out
}

/** The share of the 7-day Claude quota used, 0..1, from `omp usage --json`; undefined when it cannot be read. */
export function quotaUsedFrom(json: unknown): number | undefined {
  if (!isRecord(json) || !Array.isArray(json.reports)) return undefined
  const fractions: number[] = []
  for (const report of json.reports) {
    if (!isRecord(report) || report.provider !== 'anthropic' || !Array.isArray(report.limits)) continue
    for (const limit of report.limits) {
      if (!isRecord(limit) || limit.id !== 'anthropic:7d' || !isRecord(limit.amount)) continue
      if (typeof limit.amount.usedFraction === 'number') fractions.push(limit.amount.usedFraction)
    }
  }
  return fractions.length ? Math.max(...fractions) : undefined
}

/** The switched-off MCP servers a prompt seems to need and this session has not been told about. */
export function hintsFor(prompt: string, hints: Record<string, string>, disabled: readonly string[], told: ReadonlySet<string>): string[] {
  return Object.entries(hints)
    .filter(([server, pattern]) => {
      if (!disabled.includes(server) || told.has(server)) return false
      try {
        return new RegExp(pattern, 'i').test(prompt)
      } catch {
        return false // a pattern that does not compile hints at nothing
      }
    })
    .map(([server]) => server)
}

// ---------------------------------------------------------------- files

const DIR = path.join(os.homedir(), '.omp', 'agent')
const CONFIG_PATH = path.join(DIR, 'token-optimiser.json')
const LOG_PATH = path.join(DIR, 'token-optimiser.jsonl')
const BASELINE_PATH = path.join(DIR, 'token-optimiser-baseline.json')
const MCP_PATH = path.join(DIR, 'mcp.json')
const QUOTA_TTL_MS = 10 * 60 * 1000

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined // absent or unreadable: the caller's default stands
  }
}

function log(entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    /* a log that cannot be written never stops a turn */
  }
}

/** The context sizes recent sessions began at. */
function sessionStarts(): number[] {
  const raw = readJson(BASELINE_PATH)
  return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number') : []
}

function disabledServers(): string[] {
  const raw = readJson(MCP_PATH)
  return isRecord(raw) && Array.isArray(raw.disabledServers) ? raw.disabledServers.filter((n): n is string => typeof n === 'string') : []
}

/** The text of an assistant message, without its thinking and tool calls. */
export function textOf(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  return message.content.map(block => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

// ---------------------------------------------------------------- extension

interface Session {
  /** The model the router last set; anything else found in its place is the person's own choice. */
  lastSet?: string
  handsOff: boolean
  /** The main loop's last answer: what a follow-up such as "yes, do it" refers to. */
  reply: string
  /** MCP servers this session has been told about. */
  told: Set<string>
}

/** The light model's reading of a prompt; undefined when it gave none in time. */
async function asked(ctx: ExtensionContext, light: string, prompt: string, reply: string): Promise<Tier | undefined> {
  try {
    // omp's own model client, on the session's login. It exists only inside omp, so it is loaded here, not at the top.
    const { completeSimple } = await import('@oh-my-pi/pi-ai')
    const model = ctx.models.resolve(light)
    if (!model) return undefined
    const answer = await completeSimple(
      model,
      { systemPrompt: CLASSIFIER_SYSTEM, messages: [{ role: 'user', content: classifierPrompt(prompt, reply), timestamp: Date.now() }] },
      { apiKey: await ctx.modelRegistry.getApiKey(model), maxTokens: 8, signal: AbortSignal.timeout(5_000) },
    )
    return parseTier(textOf(answer))
  } catch {
    return undefined // no client, no login or no answer in time: the rules decide
  }
}

// Child sessions share this module, so what belongs to one session is keyed by its id.
const sessions = new Map<string, Session>()
const quota = { used: undefined as number | undefined, at: 0, busy: false }

export default function (pi: ExtensionAPI) {
  const refreshQuota = async () => {
    if (quota.busy || Date.now() - quota.at < QUOTA_TTL_MS) return
    quota.busy = true
    try {
      // The running binary is omp itself; a non-login shell (ssh, launchd) may not have it on PATH.
      const bin = path.basename(process.execPath).startsWith('omp') ? process.execPath : 'omp'
      const res = await pi.exec(bin, ['usage', '--json'], { timeout: 45_000 })
      quota.used = quotaUsedFrom(JSON.parse(res.stdout))
      quota.at = Date.now()
      log({ event: 'quota', used: quota.used })
    } catch (e) {
      quota.at = Date.now() - QUOTA_TTL_MS + 60_000 // try again in a minute
      log({ event: 'quota-error', error: String(e).slice(0, 160) })
    } finally {
      quota.busy = false
    }
  }

  pi.on('session_start', async () => {
    void refreshQuota()
  })

  pi.on('before_subagent_spawn', async event => {
    const cfg = mergeConfig(readJson(CONFIG_PATH))
    if (!cfg.enabled) return
    const choice = subagentTier(event.agent, quota.used, cfg)
    if (!choice) return
    void refreshQuota()
    const { wanted, tier } = choice
    const model = cfg.tiers[tier]
    log({ event: 'subagent', agent: event.agent, wanted, tier, model, quota: quota.used })
    return { model, note: `token-optimiser: ${event.agent} is a ${wanted} agent${tier === wanted ? '' : `, held to ${tier} by the quota guard`}` }
  })

  pi.on('before_agent_start', async (event, ctx: ExtensionContext) => {
    if (event.reason !== 'prompt' || ctx.agent?.kind === 'sub') return
    const cfg = mergeConfig(readJson(CONFIG_PATH))
    if (!cfg.enabled) return
    const id = ctx.sessionManager.getSessionId()
    const isNew = !sessions.has(id)
    const s = sessions.get(id) ?? { handsOff: false, reply: '', told: new Set<string>() }
    sessions.set(id, s)

    for (const server of hintsFor(event.prompt, cfg.mcpHints, disabledServers(), s.told)) {
      s.told.add(server)
      ctx.ui.notify(`token-optimiser: the ${server} MCP server is off to keep every request small; /mcp enable ${server} turns it on`, 'warning')
      log({ event: 'mcp-hint', server })
    }

    const now = ctx.models.current()
    const current = now ? `${now.provider}/${now.id}` : undefined
    if (s.lastSet && current && current !== s.lastSet) s.handsOff = true
    if (s.handsOff) return

    const tokens = ctx.getContextUsage()?.tokens ?? 0
    const starts = sessionStarts()
    if (isNew && tokens > 0) {
      try {
        fs.writeFileSync(BASELINE_PATH, JSON.stringify([...starts, tokens].slice(-30)))
      } catch {
        /* the baseline is a hint; losing it only makes the router cautious */
      }
    }
    void refreshQuota()
    const state = { tokens, baseline: baselineOf(starts, tokens), quotaUsed: quota.used, current: tierOf(current, cfg.tiers) }
    const entry = { event: 'main', model: current, ...state }
    if (openTiers(state, cfg).length === 0) return void log({ ...entry, action: 'not read', why: 'no move is open' })

    const read = await asked(ctx, cfg.tiers.light, event.prompt, s.reply)
    const wanted = read ?? classify(event.prompt).tier
    const { tier, action, why } = decide(wanted, state, cfg)
    const decided = { ...entry, wanted, by: read ? 'model' : 'rules', tier, why }
    if (action !== 'switch') return void log({ ...decided, action })
    const target = cfg.tiers[tier]
    const model = ctx.models.resolve(target)
    if (!model) return void log({ ...decided, action: 'model not available' })
    const ok = await pi.setModel(model)
    if (ok) {
      s.lastSet = target
      ctx.ui.notify(`token-optimiser: ${target.split('/').pop()} (${why})`, 'info')
    }
    log({ ...decided, action: ok ? 'switch' : 'setModel refused' })
  })

  pi.on('agent_end', async (event, ctx: ExtensionContext) => {
    const s = sessions.get(ctx.sessionManager.getSessionId())
    if (s) s.reply = textOf(event.messages.findLast(message => message.role === 'assistant')) || s.reply
  })
}
