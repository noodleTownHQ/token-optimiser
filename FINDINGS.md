# Findings

A dated log of what was measured and what changed because of it. Newest first. Raw cost snapshots are in [`findings/cost.jsonl`](findings/cost.jsonl) (`bun omp/cost.ts --snapshot`); the replay figures come from `bun omp/replay.ts`. Everything here is from one install (the author's), so treat it as one data point.

## 21 Nov 2026: a hand-picked model is held, not kept for the session (0.8.0)

Observed on a long session: the person picked a strong model by hand for one piece of work, and every later prompt of the session ran on it, the short follow-ups included, because a hand pick stopped routing until the session ended. Nothing in the log said so.

What changed: a pick is left alone for 5 prompts (`pickHold`, `handPickPrompts`), one line says so, each held prompt is logged as `left alone`, and then routing resumes. Five is a judgement, not a measurement: long enough for the piece of work the pick was for, short enough that a forgotten pick stops costing.

## 21 Nov 2026: unused MCP tools switched off (0.7.0)

One install, omp 19.1.0, three MCP servers offering 869 tools. Input tokens of a session's first request (`reply with the single word ok`):

| Tools in the request | First request |
|---|---|
| all 869 MCP tools | 128,734 |
| the 112 that were ever called (the rule, with its evidence met) | 64,925 |
| no MCP tools | 53,886 |

Distinct MCP tools called, from the session files: 65 in the last 7 days, 105 in 14, 159 in 30.

What changed because of it:

- **Per tool, not per server.** Two of the three servers carry 860 of the 869 tools and both are in daily use, so a per-server rule could switch off 9 tools at most.
- **No token estimate is shown.** Four characters a token over each tool's name and description said the 757 tools were 90,401 tokens; the measured difference was 63,809. The tool counts are exact, so those are what is reported.
- **Nothing is switched back on mid-session.** Tried: after 228 tools were switched off and on again in one session, omp sent them in full (240 tool definitions with input schemas, where they had been one-line entries), and the model API refused every request with a 400 on a parameter named `$filter`. A restore applies from the next session, where the tools load the usual way; checked, no error.
- **Subagent sessions are read too.** 45 distinct MCP tools were called from subagent session files, which sit in folders beside the parent's file.

Reading 30 days of session files for calls took 1,049 ms the first time; a repeat read of 14 days from the cache took 20 ms.

## 21 Nov 2026: baseline for the before/after figure (0.6.0)

Cost by window, price index (billed over the same tokens at Opus 5.5 prices; 1.00 is all Opus):

| Window | Turns | Billed | Index | Median context |
|---|---|---|---|---|
| before (no router, 29 Oct to 12 Nov) | 94 | $1,146.06 | 0.99 | 470k |
| interim (regex router, 30k-token ceiling, to 21 Nov 12:15 UTC) | 738 | $513.49 | 0.64 | 201k |
| after (0.6.0, from 21 Nov 12:15 UTC) | 5 | $1.85 | 0.38 | 224k |

The windows hold different work, so the index mixes the router's effect with the task mix. `before` is mostly eight long unattended runs (about $1,000 of $1,146). `after` has five turns and says nothing yet. Next reading: about 5 Dec 2026.

## 21 Nov 2026: the context ceiling removed (0.6.0)

Replay of 849 turns in 64 sessions (30 days to 21 Nov), one-hour cache, baseline 1.00 = what they were billed:

| Rule | Saved | Model moves |
|---|---|---|
| follow the tier at any size | 34.9% | 231 |
| move down only | 39.6% | 170 |
| with hindsight, decline the moves that did not pay | 39.7% | 112 |

A size limit adds at most 0.1 of a point over moving down every time, so the ceiling went. The gap between 34.9% and 39.6% is heavy work the rule moves up to Opus where the recorded sessions ran it on a cheaper model; that is spent on purpose. Five-minute cache: 35.0 / 39.6 / 39.7.

Observed on the first live long session: at 207,178 tokens the main loop moved Fable to Haiku, then at 199,727 tokens Haiku to Sonnet. Each move wrote the whole context once (199,725 and 203,187 tokens); the next Sonnet requests read it from cache.

## 21 Nov 2026: Haiku 5.5 as the classifier

Smoke test on 18 labelled prompts: Haiku 18/18, fixed rules 15/18. Median 529 ms and $0.00003 per read.
