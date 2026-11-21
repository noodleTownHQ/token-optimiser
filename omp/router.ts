// token-optimiser for omp: the model follows the job. The decisions are ../core/router.ts; this file is omp's side of them.
//
//   1. Subagents (before_subagent_spawn): each agent type has a tier, and a child that names no model gets that tier's.
//   2. Main loop (before_agent_start): the light model reads the prompt (the core's rules when it cannot) and the model
//      follows, down as well as up, at any context size. A model the person picks by hand (/model) is never touched
//      again in that session.
//   3. Quota guard: as the 7-day Claude quota (`omp usage`) runs out, heavy work drops to the standard model, then all of it to light.
//   4. MCP tool load (../core/mcp.ts): every connected tool is listed in every request. At a session's first prompt the tools
//      that earlier sessions loaded and never called are switched off for the session, and one line says so.
//      /tokens-mcp shows each server's load and the reason for every tool; /tokens-mcp restore gives one back.
//
// Thinking effort is omp's own (`ultrathink` and `chillax` steer it); nothing here changes it.
// Settings: ~/.omp/agent/token-optimiser.json, read on every prompt, so an edit applies at once. Log: token-optimiser.jsonl beside it.
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { DEFAULT_MCP, emptyState, listServer, modelNote, planTrim, recordPrompt, report, restore, summary } from '../core/mcp'
import type { McpPolicy, McpState, ToolInfo } from '../core/mcp'
import { CLASSIFIER_SYSTEM, DEFAULT_GUARD, TIERS, classifierPrompt, classify, decide, isRecord, parseSubagents, parseTier, subagentTier, tierOf } from '../core/router'
import type { Policy, Tier } from '../core/router'
import { readUsage } from './usage'

export interface RouterConfig extends Policy {
  enabled: boolean
  /** Tier -> model, as `provider/id`. */
  tiers: Record<Tier, string>
  /**
   * MCP server -> pattern (a case-insensitive regular expression). When a prompt matches and the server is switched off in
   * mcp.json, the router says once per session how to turn it on. Empty by default: see examples/omp-config.json.
   */
  mcpHints: Record<string, string>
  /** Switching off MCP tools that are loaded and never called. */
  mcp: McpPolicy
}

export const DEFAULT_CONFIG: RouterConfig = {
  enabled: true,
  tiers: {
    light: 'anthropic/claude-haiku-5-5',
    standard: 'anthropic/claude-sonnet-5-5',
    heavy: 'anthropic/claude-opus-5-5',
  },
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
  mcp: DEFAULT_MCP,
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
  if (isRecord(raw.mcp)) {
    const m = raw.mcp
    if (m.trim === 'auto' || m.trim === 'propose' || m.trim === 'off') out.mcp.trim = m.trim
    if (Array.isArray(m.keep)) out.mcp.keep = m.keep.filter((n): n is string => typeof n === 'string')
    for (const key of ['prompts', 'minSessions', 'sessions'] as const) {
      const n = m[key]
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) out.mcp[key] = n
    }
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
const MCP_PATH = path.join(DIR, 'mcp.json')
/** The evidence for the MCP trim: per tool, prompts and sessions loaded without a call, and the restored list. */
const MCP_STATE_PATH = path.join(DIR, 'token-optimiser-mcp.json')
/** Each session file's MCP calls, so that only changed files are read again. */
const USAGE_PATH = path.join(DIR, 'token-optimiser-usage.json')
/** The longest a session's first prompt waits for the session files to be read; what is left is read next session. */
const USAGE_BUDGET_MS = 3_000
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

/** The evidence file; anything of the wrong shape is dropped, so a damaged file costs evidence, never a session. */
export function parseMcpState(raw: unknown): McpState {
  const state = emptyState()
  if (!isRecord(raw)) return state
  if (isRecord(raw.tools)) {
    for (const [name, e] of Object.entries(raw.tools)) {
      if (!isRecord(e) || typeof e.prompts !== 'number' || typeof e.sessions !== 'number') continue
      state.tools[name] = { prompts: e.prompts, sessions: e.sessions, ...(typeof e.used === 'number' ? { used: e.used } : {}) }
    }
  }
  if (Array.isArray(raw.restored)) state.restored = raw.restored.filter((n): n is string => typeof n === 'string')
  return state
}

function saveMcpState(state: McpState): void {
  try {
    const tmp = `${MCP_STATE_PATH}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, MCP_STATE_PATH) // whole file or nothing: another session may be reading it
  } catch {
    /* evidence that cannot be written is collected again */
  }
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
  /** MCP tools counted as loaded for this session; undefined until its first prompt has been handled. */
  loaded?: string[]
  /** What the model is told about switched-off tools, on every prompt of the session so the system prompt stays the same. */
  note?: string
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

/** The prompt's system prompt with `note` added as a last block; undefined when there is no note or no prompt to add it to. */
function withNote(event: unknown, note: string | undefined): { systemPrompt: string | string[] } | undefined {
  if (!note || !isRecord(event)) return undefined
  const base = event.systemPrompt
  if (Array.isArray(base)) return { systemPrompt: [...base.filter((b): b is string => typeof b === 'string'), note] }
  if (typeof base === 'string') return { systemPrompt: `${base}\n\n${note}` }
  return undefined
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

  const mcpTools = (): ToolInfo[] => pi.getAllTools().filter(t => typeof t.mcpServerName === 'string')

  /**
   * One prompt of the MCP trim. On a session's first prompt: read what was called, decide from the evidence of earlier
   * sessions, switch the idle tools off and say so. On every prompt: count it as evidence for the tools that are loaded.
   * Tools are only ever removed here. One added back mid-session is sent by omp in full, with its input schema, where it
   * was a one-line entry before; that is why a restore waits for the next session.
   */
  const mcpStep = (policy: McpPolicy, s: Session, ctx: ExtensionContext) => {
    if (policy.trim === 'off') return
    let state = parseMcpState(readJson(MCP_STATE_PATH))
    if (s.loaded) return saveMcpState(recordPrompt(state, s.loaded, new Map(), false))

    const tools = mcpTools()
    s.loaded = []
    if (!tools.length) return
    const { lastUsed, complete } = readUsage(USAGE_PATH, USAGE_BUDGET_MS)
    state = recordPrompt(state, [], lastUsed, false)
    if (!complete) {
      // Not every session file was read in time, so a call may be missing: count the evidence, switch nothing off.
      s.loaded = tools.map(t => t.name)
      log({ event: 'mcp-trim', mode: policy.trim, skipped: 'session files still being read' })
      return saveMcpState(recordPrompt(state, s.loaded, new Map(), true))
    }
    const plan = planTrim(tools, state, policy)
    const off = new Set(plan.flatMap(server => server.off))
    if (off.size && policy.trim === 'auto') {
      pi.setActiveTools(pi.getActiveTools().filter(name => !off.has(name)))
      s.note = modelNote(plan)
    }
    const line = summary(plan, policy)
    if (line) ctx.ui.notify(`token-optimiser: ${line}`, 'info')
    log({
      event: 'mcp-trim',
      mode: policy.trim,
      servers: plan.map(p => ({ server: p.server, on: p.on.length, off: p.off.length })),
    })
    s.loaded = tools.map(t => t.name).filter(name => policy.trim !== 'auto' || !off.has(name))
    saveMcpState(recordPrompt(state, s.loaded, new Map(), true))
  }

  pi.registerCommand('tokens-mcp', {
    description: 'token-optimiser: what each MCP server adds to every request and why its tools are on or off. `list <server>` names them; `restore <server or tool>` gives one back',
    handler: async (args: string, ctx: ExtensionContext) => {
      const policy = mergeConfig(readJson(CONFIG_PATH)).mcp
      const tools = mcpTools()
      const state = parseMcpState(readJson(MCP_STATE_PATH))
      const [verb, ...rest] = (args ?? '').trim().split(/\s+/)
      const name = rest.join(' ')
      if (verb === 'restore' && name) {
        const next = restore(state, name, tools)
        if (!next) return ctx.ui.notify(`token-optimiser: no connected MCP server or tool is called ${name}`, 'warning')
        saveMcpState(next)
        log({ event: 'mcp-restore', name })
        return ctx.ui.notify(`token-optimiser: ${name} will not be switched off again; its tools are back from the next session`, 'info')
      }
      if (verb === 'list' && name) return ctx.ui.notify(listServer(name, tools, state, policy) ?? `token-optimiser: no connected MCP server is called ${name}`, 'info')
      ctx.ui.notify(report(planTrim(tools, state, policy), state, policy, Date.now()), 'info')
    },
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
    const s = sessions.get(id) ?? { handsOff: false, reply: '', told: new Set<string>() }
    sessions.set(id, s)

    try {
      mcpStep(cfg.mcp, s, ctx)
    } catch (e) {
      log({ event: 'mcp-error', error: String(e).slice(0, 160) }) // the trim never stops a prompt
    }
    const extra = withNote(event, s.note)

    for (const server of hintsFor(event.prompt, cfg.mcpHints, disabledServers(), s.told)) {
      s.told.add(server)
      ctx.ui.notify(`token-optimiser: the ${server} MCP server is off to keep every request small; /mcp enable ${server} turns it on`, 'warning')
      log({ event: 'mcp-hint', server })
    }

    const now = ctx.models.current()
    const current = now ? `${now.provider}/${now.id}` : undefined
    if (s.lastSet && current && current !== s.lastSet) s.handsOff = true
    if (s.handsOff) return extra

    void refreshQuota()
    const state = { quotaUsed: quota.used, current: tierOf(current, cfg.tiers) }
    const entry = { event: 'main', model: current, tokens: ctx.getContextUsage()?.tokens ?? 0, ...state }

    const read = await asked(ctx, cfg.tiers.light, event.prompt, s.reply)
    const wanted = read ?? classify(event.prompt).tier
    const { tier, action, why } = decide(wanted, state, cfg)
    const decided = { ...entry, wanted, by: read ? 'model' : 'rules', tier, why }
    if (action !== 'switch') {
      log({ ...decided, action })
      return extra
    }
    const target = cfg.tiers[tier]
    const model = ctx.models.resolve(target)
    if (!model) {
      log({ ...decided, action: 'model not available' })
      return extra
    }
    const ok = await pi.setModel(model)
    if (ok) {
      s.lastSet = target
      ctx.ui.notify(`token-optimiser: ${target.split('/').pop()} (${why})`, 'info')
    }
    log({ ...decided, action: ok ? 'switch' : 'setModel refused' })
    return extra
  })

  pi.on('agent_end', async (event, ctx: ExtensionContext) => {
    const s = sessions.get(ctx.sessionManager.getSessionId())
    if (s) s.reply = textOf(event.messages.findLast(message => message.role === 'assistant')) || s.reply
  })
}
