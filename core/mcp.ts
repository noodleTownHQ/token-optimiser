// MCP tool load: every tool a connected server offers is listed in the model's prompt on every request, used or not.
// Pure functions, no host code: the omp extension feeds them the tool list and the evidence it keeps.
//
// The rule, per tool: a tool is switched off once it has been loaded and left uncalled over `prompts` prompts spread
// across at least `minSessions` sessions, or over `sessions` sessions of any length. A tool that was ever called, that the
// person restored, or that `keep` names, is never switched off. Per tool, not per server, because one server can carry
// hundreds of tools of which a handful are used.
//
// It is decided at a session's first prompt, before its first request, from the evidence of earlier sessions: the tool
// list sits at the front of the prompt, so that is when changing it costs no cache write. A restore applies from the next
// session for the same reason, and because a host may send a tool differently once it is added back mid-session.

export interface ToolInfo {
  name: string
  /** Set by the host on a tool that came from an MCP server. */
  mcpServerName?: string
}

export type TrimMode = 'auto' | 'propose' | 'off'

export interface McpPolicy {
  /** `auto` switches idle tools off, `propose` only reports them, `off` does neither and keeps no evidence. */
  trim: TrimMode
  /** Servers or tools never switched off, by name. */
  keep: string[]
  /** Prompts a tool must be loaded and uncalled... */
  prompts: number
  /** ...across at least this many sessions, */
  minSessions: number
  /** or this many sessions, however short. */
  sessions: number
}

export const DEFAULT_MCP: McpPolicy = { trim: 'auto', keep: [], prompts: 10, minSessions: 2, sessions: 5 }

/** What is known about one tool: how long it has been loaded without a call, and when it was last called. */
export interface Evidence {
  prompts: number
  sessions: number
  /** Epoch ms of the last call on record; absent when there is none. */
  used?: number
}

export interface McpState {
  tools: Record<string, Evidence>
  /** Servers or tools the person gave back; never switched off again. */
  restored: string[]
}

export const emptyState = (): McpState => ({ tools: {}, restored: [] })

/** `Acme-Docs`, `acme_docs` and `acme docs` are one name. */
export const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * The evidence after one more prompt: every loaded tool has been loaded for one more prompt (and, on a session's first
 * prompt, one more session), and a call on record marks its tool as used.
 */
export function recordPrompt(state: McpState, loaded: readonly string[], lastUsed: ReadonlyMap<string, number>, firstOfSession: boolean): McpState {
  const tools: Record<string, Evidence> = { ...state.tools }
  for (const name of loaded) {
    const was = tools[name] ?? { prompts: 0, sessions: 0 }
    tools[name] = { ...was, prompts: was.prompts + 1, sessions: was.sessions + (firstOfSession ? 1 : 0) }
  }
  for (const [name, at] of lastUsed) {
    const was = tools[name] ?? { prompts: 0, sessions: 0 }
    if ((was.used ?? 0) < at) tools[name] = { ...was, used: at }
  }
  return { ...state, tools }
}

export interface ServerState {
  server: string
  /** Tools left on, and tools the rule switches off. */
  on: string[]
  off: string[]
  /** The last time (epoch ms) any of the server's tools was called, when one was. */
  lastUsed?: number
}

/** Why a tool stays on, or undefined when the rule switches it off. */
export function staysOn(tool: ToolInfo, state: McpState, policy: McpPolicy): string | undefined {
  const named = (list: readonly string[]) => {
    const names = new Set(list.map(normalise))
    return names.has(normalise(tool.name)) || (tool.mcpServerName !== undefined && names.has(normalise(tool.mcpServerName)))
  }
  if (named(policy.keep)) return 'kept by the settings'
  if (named(state.restored)) return 'restored'
  const e = state.tools[tool.name]
  if (e?.used !== undefined) return 'has been called'
  const prompts = e?.prompts ?? 0
  const sessions = e?.sessions ?? 0
  if ((prompts >= policy.prompts && sessions >= policy.minSessions) || sessions >= policy.sessions) return undefined
  return `not enough evidence yet (${prompts} prompts over ${sessions} sessions without a call)`
}

/** Each MCP server's tools split into on and off, largest saving first. Tools that are not MCP tools are never touched. */
export function planTrim(tools: readonly ToolInfo[], state: McpState, policy: McpPolicy): ServerState[] {
  const by = new Map<string, ServerState>()
  for (const tool of tools) {
    const server = tool.mcpServerName
    if (!server) continue
    const s = by.get(server) ?? { server, on: [], off: [] }
    by.set(server, s)
    const used = state.tools[tool.name]?.used
    if (used !== undefined) s.lastUsed = Math.max(s.lastUsed ?? 0, used)
    if (policy.trim !== 'off' && staysOn(tool, state, policy) === undefined) s.off.push(tool.name)
    else s.on.push(tool.name)
  }
  return [...by.values()].sort((a, b) => b.off.length - a.off.length || a.server.localeCompare(b.server))
}

/** `name` added to the restored list when it names a connected server or tool; undefined when it names neither. */
export function restore(state: McpState, name: string, tools: readonly ToolInfo[]): McpState | undefined {
  const wanted = normalise(name)
  const match = tools.find(t => normalise(t.name) === wanted)?.name ?? tools.find(t => t.mcpServerName && normalise(t.mcpServerName) === wanted)?.mcpServerName
  if (!match) return undefined
  return state.restored.includes(match) ? state : { ...state, restored: [...state.restored, match] }
}

const sum = (states: readonly ServerState[], pick: (s: ServerState) => number) => states.reduce((total, s) => total + pick(s), 0)

const evidenceText = (p: McpPolicy) => `loaded and never called over ${p.prompts} prompts in ${p.minSessions} or more sessions, or over ${p.sessions} sessions`

/** One line for the person at the start of a session. Undefined when the rule switches nothing off. */
export function summary(states: readonly ServerState[], policy: McpPolicy): string | undefined {
  const off = sum(states, s => s.off.length)
  if (!off || policy.trim === 'off') return undefined
  const what = `${off} of ${off + sum(states, s => s.on.length)} MCP tools`
  return policy.trim === 'auto'
    ? `${what} are off for this session: never called. /tokens-mcp lists them; /tokens-mcp restore <server or tool> gives one back`
    : `${what} have never been called and could be switched off: set mcp.trim to "auto". /tokens-mcp lists them`
}

/** What the model is told, so that a missing tool is reported to the person, not worked around. Undefined when nothing is off. */
export function modelNote(states: readonly ServerState[]): string | undefined {
  const trimmed = states.filter(s => s.off.length)
  if (!trimmed.length) return undefined
  const list = trimmed.map(s => `${s.server} (${s.off.length})`).join(', ')
  return `Some MCP tools that have never been used are switched off to keep requests small: ${list}. If the task needs a tool from one of these servers that you cannot see, say so and tell the person that \`/tokens-mcp restore <server>\` gives the server's tools back from the next session.`
}

/** A table of what each server adds to the prompt, what the rule switches off and why. */
export function report(states: readonly ServerState[], state: McpState, policy: McpPolicy, now: number): string {
  if (!states.length) return 'No MCP servers are connected.'
  const rows = states.map(s => {
    const used = s.lastUsed === undefined ? 'no call on record' : `last call ${Math.floor((now - s.lastUsed) / 86_400_000)}d ago`
    return `${s.server.padEnd(28)} ${String(s.on.length).padStart(4)} on ${String(s.off.length).padStart(4)} off  ${used}`
  })
  const off = sum(states, s => s.off.length)
  const verb = policy.trim === 'auto' ? 'off' : 'proposed'
  const lines = [...rows, '', `${states.length} servers, ${off + sum(states, s => s.on.length)} tools; ${off} ${verb}.`]
  if (policy.trim === 'off') lines.push('Trimming is switched off (mcp.trim).')
  else lines.push(`A tool is ${verb} once it has been ${evidenceText(policy)}. A tool that was ever called is never switched off.`)
  if (state.restored.length) lines.push(`Restored, never switched off again: ${state.restored.join(', ')}.`)
  lines.push('`/tokens-mcp restore <server or tool>` gives one back from the next session; `/tokens-mcp list <server>` names its tools.')
  return lines.join('\n')
}

/** The tools of one server, each with why it is on or off. */
export function listServer(server: string, tools: readonly ToolInfo[], state: McpState, policy: McpPolicy): string | undefined {
  const wanted = normalise(server)
  const own = tools.filter(t => t.mcpServerName && normalise(t.mcpServerName) === wanted)
  if (!own.length) return undefined
  return own.map(t => `${t.name}: ${staysOn(t, state, policy) ?? `off, ${evidenceText(policy)}`}`).join('\n')
}
