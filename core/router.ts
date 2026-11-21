// What the router decides, for both hosts: omp (omp/router.ts) and Claude Code (hooks/route.ts).
// Pure functions: no files, no processes, no host API, so each host loads this file as it is.
//
// The rule behind it, measured on one omp install over two weeks (29 Oct-12 Nov 2026): Opus was 54% of $3,170, 90% of that
// was the context being re-read or re-written (median request 403k tokens), and Opus costs twice Sonnet on every token type.
// So a cheaper model is chosen where the choice is free (a subagent starts empty; a new or freshly compacted session is
// small), and past that the model only ever moves up, when the work needs it: the prompt cache is worth more than a
// cheaper model would save.

export const TIERS = ['light', 'standard', 'heavy'] as const
export type Tier = (typeof TIERS)[number]

export interface QuotaGuard {
  enabled: boolean
  /** Past this share of the 7-day quota (0..1), heavy work runs on the standard model. */
  holdHeavyAt: number
  /** Past this share, everything runs on the light model. */
  lightOnlyAt: number
}

export interface Policy {
  /** The main loop changes model only while its context holds at most this many tokens more than an empty session's. */
  contextCeilingTokens: number
  quotaGuard: QuotaGuard
  /** Agent type -> tier. An agent not listed keeps the model it would have had. */
  subagents: Record<string, Tier>
}

export const DEFAULT_CEILING = 30_000
export const DEFAULT_GUARD: QuotaGuard = { enabled: true, holdHeavyAt: 0.7, lightOnlyAt: 0.9 }

// ---------------------------------------------------------------- how hard is the prompt, by rules

const HEAVY_WORDS: RegExp[] = [
  /\barchitect(?:ure|ural)?\b/i,
  /\bdesign (?:the|a|an|this)\b/i,
  /\btrade-?offs?\b/i,
  /\broot[- ]cause\b/i,
  /\brace condition|\bdeadlock|\bconcurren(?:t|cy)\b/i,
  /\bmigrat(?:e|ion|ing)\b/i,
  /\bsecurity|\bthreat model|\baudit\b|\bvulnerab/i,
  /\brefactor\b.*\b(?:whole|entire|across|all)\b|\b(?:whole|entire|across|all)\b.*\brefactor\b/i,
  /\bend[- ]to[- ]end\b|\bfrom scratch\b|\brewrite\b/i,
  /\binvestigate\b|\bintermittent\b|\bmemory leak\b|\bregression\b/i,
  /\bwhy (?:does|is|are|did|do)\b/i,
  /\b(?:plan|spec|rfc)\b.*\b(?:for|to)\b|\bplan (?:the|this|a)\b/i,
  /\bdata loss\b|\bincident\b|\bproduction\b.*\b(?:down|broken|failing)\b/i,
  /\bultrathink\b/i,
]

const LIGHT_START =
  /^\s*(?:what(?:'s| is| does)?|where|which|who|show|list|print|cat|read|open|find|grep|search|rename|fix (?:the )?typo|add (?:a )?comment|commit|push|git|status|diff|run|undo|revert|summari[sz]e|explain)\b/i

const PATH_RE = /(?:^|[\s"'`(])((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})\b/g

export interface Classification {
  tier: Tier
  reasons: string[]
}

/** The tier a prompt asks for, by rules. Free and instant, but blind to meaning: what a host uses when it cannot ask the light model. */
export function classify(prompt: string): Classification {
  const text = prompt.replace(/```[\s\S]*?```/g, ' ').trim()
  const reasons: string[] = []
  let heavy = 0
  let light = 0
  for (const re of HEAVY_WORDS) {
    if (re.test(text)) {
      heavy += 2
      reasons.push(`heavy:${re.source.slice(0, 24)}`)
    }
  }
  if (text.length > 1500) {
    heavy += 1
    reasons.push('long prompt')
  }
  const files = new Set<string>()
  for (const m of text.matchAll(PATH_RE)) files.add(m[1]!)
  if (files.size >= 3) {
    heavy += 1
    reasons.push(`${files.size} files named`)
  }
  if ((text.match(/^\s*(?:\d+[.)]|[-*])\s+\S/gm) ?? []).length >= 4) {
    heavy += 1
    reasons.push('multi-part list')
  }
  if (/\bchillax\b/i.test(text)) {
    light += 2
    reasons.push('chillax')
  }
  if (LIGHT_START.test(text) && text.length < 240) {
    light += 2
    reasons.push('short lookup or mechanical request')
  } else if (text.length < 100) {
    light += 1
    reasons.push('very short')
  }
  if (heavy >= 2) return { tier: 'heavy', reasons }
  if (light >= 2 && heavy === 0) return { tier: 'light', reasons }
  return { tier: 'standard', reasons: reasons.length ? reasons : ['default'] }
}

// ---------------------------------------------------------------- asking the light model
//
// The rules above match words, not meaning, and cannot tell what "yes, do it" refers to. So each host first asks its
// light model (one request of a few hundred tokens) and falls back on the rules when that call fails.

export const CLASSIFIER_SYSTEM = `You route the next turn of a coding assistant to a model tier. Reply with one word: light, standard or heavy.
light: a lookup, a question about what code does, a mechanical or single-step change (rename, typo, run a command, commit).
standard: ordinary implementation: a feature or a fix with a clear path in a few files.
heavy: design or architecture, the root cause of an unclear bug, a security review, a migration, a change across many files, anything where a wrong answer is expensive.
A short follow-up ("yes", "do it", "continue") takes the tier of the work the assistant's last reply proposed.
The word ultrathink in the request asks for heavy, chillax for light.`

/** What the classifier is shown: the end of the assistant's last reply, so a follow-up can be read, then the request. */
export function classifierPrompt(prompt: string, lastReply: string): string {
  const before = lastReply.trim() ? `End of the assistant's last reply:\n${lastReply.trim().slice(-600)}\n\n` : ''
  return `${before}Next request:\n${prompt.slice(0, 2_000)}`
}

/** The tier in a classifier's reply; undefined when it named none. */
export function parseTier(reply: string): Tier | undefined {
  const word = /\b(light|standard|heavy)\b/i.exec(reply)?.[1]?.toLowerCase()
  return TIERS.find(tier => tier === word)
}

// ---------------------------------------------------------------- what the quota and the cache allow

/** The tier the 7-day quota allows. An unknown quota (an API key, or before the first request) never holds anything back. */
export function guardedTier(tier: Tier, quotaUsed: number | undefined, guard: QuotaGuard): Tier {
  if (!guard.enabled || quotaUsed === undefined) return tier
  const cap: Tier = quotaUsed >= guard.lightOnlyAt ? 'light' : quotaUsed >= guard.holdHeavyAt ? 'standard' : 'heavy'
  return TIERS.indexOf(tier) > TIERS.indexOf(cap) ? cap : tier
}

/**
 * The context of an empty session: the smallest size recent sessions began at, or the current one when there is none.
 * A new session already holds the system prompt and every tool schema, so "small" is measured from here, not from zero.
 */
export function baselineOf(observations: readonly number[], now: number): number {
  return Math.min(...observations, now)
}

/** The state of the main loop as a prompt arrives. */
export interface Reading {
  /** Tokens in the context now. */
  tokens: number
  /** Tokens in the context of an empty session (see baselineOf). */
  baseline: number
  /** Share of the 7-day quota used, 0..1, when the host can tell. */
  quotaUsed?: number
  /** The tier the loop runs on; undefined when its model is not one of the tiers'. */
  current?: Tier
}

/**
 * The tiers the loop may move to now; when there is none, the prompt need not be classified at all.
 * Down, or off a model outside the tiers, only while the context is small: past the ceiling the prompt cache is worth
 * more than a cheaper model saves. Up at any size: an answer from too weak a model wastes more than one cache rewrite.
 * Never above what the quota allows.
 */
export function openTiers(now: Reading, policy: Policy): Tier[] {
  const cap = TIERS.indexOf(guardedTier('heavy', now.quotaUsed, policy.quotaGuard))
  const from = now.current === undefined ? Infinity : TIERS.indexOf(now.current)
  const isSmall = now.tokens - now.baseline <= policy.contextCeilingTokens
  return TIERS.filter((tier, rank) => tier !== now.current && rank <= cap && (isSmall || rank > from))
}

/** The tier a model serves in a tier -> model table, if it serves one. */
export function tierOf(model: string | undefined, models: Record<Tier, string>): Tier | undefined {
  return TIERS.find(tier => models[tier] === model)
}

/** What the router does with one prompt, and why, in words a person can check against the rules here. */
export interface Decision {
  /** The tier the quota allows the prompt. */
  tier: Tier
  action: 'switch' | 'keep' | 'hold'
  why: string
}

/** The same inputs always give the same decision: only reading the prompt (`wanted`) is ever a model's judgement. */
export function decide(wanted: Tier, now: Reading, policy: Policy): Decision {
  const tier = guardedTier(wanted, now.quotaUsed, policy.quotaGuard)
  const asks = tier === wanted ? `${wanted} work` : `${wanted} work, held to ${tier} by the quota guard`
  if (tier === now.current) return { tier, action: 'keep', why: `${asks}: already on the ${tier} model` }
  if (!openTiers(now, policy).includes(tier)) {
    return { tier, action: 'hold', why: `${asks}: the context is past the ceiling, so the model stays and its cache is kept` }
  }
  return { tier, action: 'switch', why: `${asks}: moved to the ${tier} model` }
}

/**
 * The tier for a subagent, by its type: a child starts with an empty context, so its model is free to choose.
 * The type is looked up whole, then without its plugin prefix (`plugin:agent`), so one table serves both hosts.
 */
export function subagentTier(agent: string | undefined, quotaUsed: number | undefined, policy: Policy): { wanted: Tier; tier: Tier } | undefined {
  if (!agent) return undefined
  const wanted = policy.subagents[agent] ?? policy.subagents[agent.slice(agent.lastIndexOf(':') + 1)]
  return wanted && { wanted, tier: guardedTier(wanted, quotaUsed, policy.quotaGuard) }
}

// ---------------------------------------------------------------- reading a person's settings

/** The package's one guard for a JSON object; its fields stay unknown and are checked where they are read. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isTier(v: unknown): v is Tier {
  return TIERS.includes(v as Tier)
}

/** An agent -> tier table from a settings value (an object, or its JSON text). Entries of the wrong shape are dropped. */
export function parseSubagents(raw: unknown): Record<string, Tier> | undefined {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!isRecord(raw)) return undefined
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, Tier] => isTier(entry[1])))
}
