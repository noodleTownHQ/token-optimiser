# token-optimiser

Spend fewer tokens in a coding agent without changing how you work. One project for two hosts: a Claude Code plugin and an [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extension, sharing one set of routing rules.

It does two things:

1. **Routes each job to the cheapest model that can do it.** A lookup runs on Haiku, ordinary implementation on Sonnet, design and root-cause work on Opus. Subagents get a model by their type.
2. **Keeps large output out of the context** (Claude Code only: omp already does this itself). Long command output is trimmed, searches go to a cheap read-only agent, edits can address lines by a hash instead of retyping them.

| | Claude Code | omp |
|---|---|---|
| Main-loop routing | yes | yes |
| Subagent routing | yes | yes |
| 7-day quota guard | yes (plan login) | yes |
| Trimmed output, scout agent, hashline edits | yes | built into omp |
| Pattern rules, advisor, edit checks, guards | yes | built into omp |
| Hint when a switched-off MCP server is needed | no | yes |

## How routing decides

Every decision follows the same steps, and each one is written down (see [Seeing why](#seeing-why)).

1. **Read the prompt.** The light model (Haiku 5.5 by default) is shown the prompt and the end of the assistant's last reply, and answers with one word: `light`, `standard` or `heavy`. The last reply is there so that "yes, do it" takes the tier of the work that was proposed. If the call fails or takes more than 5 seconds, a fixed set of rules (keywords, length, number of files named) reads the prompt instead.
2. **Apply the quota guard.** On a plan login, once 70% of the 7-day limit is used, heavy work runs on the standard model; from 90% everything runs on the light model. On an API key there is no limit to read and nothing is held.
3. **Move, or stay.** The loop moves when the tier differs from the one it is on: down as well as up, at any context size. The choice holds until a later prompt changes it.

Only step 1 is a model's judgement. Steps 2 and 3 are plain functions in [`core/router.ts`](core/router.ts): the same inputs always give the same decision.

### Why it moves down in a long session

A move writes the context once into the new model's prompt cache. At the prices omp bills, a one-hour cache write on Sonnet 5.5 costs twice its input price ($4 per million tokens), and each request after it reads that context for $0.10 per million less than Opus 5.5 would. The move has paid for itself after 40 requests on cache reads alone, sooner once output is counted (25 requests with a five-minute cache, whose write costs 1.25 times input). The model moved away from keeps its own cache (an hour on a plan login, five minutes on an API key), so moving back usually costs a read, not a second write.

Checked against real use: 845 main-loop turns recorded by one omp install (70 sessions, the 30 days to 21 Nov 2026) were replayed with each turn on its tier's model and every cache write and expiry counted. Priced on the models actually used, the replay comes to 1.00 of what those sessions were billed. Following the tier cost 35% less, with a one-hour cache and with a five-minute one. Nearly all of the saving is ordinary work on Sonnet instead of Opus; lookups on Haiku add under 2 points.

A context-size limit would not have helped. Moving down every time saved 39.5%; choosing with hindsight when to decline a move saved 39.7%. The rest of the gap to 35% is heavy work that the rule moves up to Opus where the recorded sessions ran it on a cheaper model: that is spent on purpose.

This is an estimate, not a bill. The replay read the prompts with the fixed rules, which call most turns `standard`, and it assumes the cheaper model makes the same requests and writes the same output.

A model you pick by hand (`/model`) is left alone for the rest of the session.

**Subagents** start with an empty context, so their model costs no cache to choose. Each agent type has a tier (Claude Code: `Explore` light, `general-purpose` standard, `Plan` heavy; omp: `scout`, `explore`, `sonic` light, `task` standard, `reviewer`, `security-reviewer`, `plan` heavy). A type not in the table, and a call that names its own model, are left alone. You can replace the table.

### Seeing why

- Claude Code: `/tokens` shows the model the loop is on, the counts, and what happened to the last prompt, for example `heavy work, held to standard by the quota guard: moved to the standard model (read by the light model)`.
- omp: every decision is a line in `~/.omp/agent/token-optimiser.jsonl` with the context size, the quota, the tier asked for, who read the prompt (`model` or `rules`), the action and the reason.

### What reading a prompt costs

Measured on 21 Nov 2026 with Haiku 5.5 through omp, 18 prompts read three times each (54 calls):

| | Result |
|---|---|
| Median time per read | 529 ms (longest 682 ms) |
| Cost per read | $0.00003 |
| Same answer all three times | 18 of 18 prompts |
| Agreed with the expected tier | 18 of 18 by the model, 15 of 18 by the rules |

The 18 prompts and their expected tiers were written by the author, so this is a smoke test, not a benchmark. The three the rules missed were follow-ups ("yes, do it", "ok go"), which rules cannot read.

Run it yourself, on your own login (54 small requests): `omp --no-extensions -e ./omp/bench.ts -p go`. The prompts are in [`omp/bench.ts`](omp/bench.ts).

## Install

### Claude Code

Needs a Claude Code version with mods (function hooks); run `claude update` first if `/tokens` is unknown after installing.

```
/plugin install token-optimiser --marketplace noodleTownHQ/token-optimiser
```

or from a shell: `claude plugin install token-optimiser --marketplace noodleTownHQ/token-optimiser`.

### omp

Clone the repository and add the extension to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/src/token-optimiser/omp/router.ts
```

To try it for one run: `omp -e ~/src/token-optimiser/omp/router.ts`.

Settings are optional. Copy [`examples/omp-config.json`](examples/omp-config.json) to `~/.omp/agent/token-optimiser.json` and edit it; the file is read on every prompt, so a change applies at once.

One omp setting is needed when a session's context can pass 100,000 tokens. omp's catalog lists Haiku 5.5 with a 100,000-token window, so above that it tries to compact the conversation whenever the router moves to the light model. Give Haiku the limit your other models have:

```
omp config set compaction.modelThresholds '{"anthropic/claude-haiku-5-5":250000}'
```

## Settings

### Claude Code

Set in the config menu (`/config`), or in `~/.claude/settings.json` under `pluginConfigs`.

| Setting | Default | What it does |
|---|---|---|
| `route` | `true` | Model routing, main loop and subagents |
| `lightModel` | `claude-haiku-5-5` | Model for light work; it also reads each prompt |
| `standardModel` | `claude-sonnet-5-5` | Model for ordinary implementation |
| `heavyModel` | `claude-opus-5-5` | Model for design and root-cause work |
| `holdHeavyAtPercent` | `70` | Share of the 7-day limit from which heavy work runs on the standard model |
| `lightOnlyAtPercent` | `90` | Share of the 7-day limit from which everything runs on the light model |
| `subagentTiers` | built-in table | JSON object of agent type to `light`, `standard` or `heavy` |
| `trimChars` | `10000` | Output longer than this is trimmed |
| `diagnostics` | `true` | Run a checker after each edit |
| `advisorModel` | empty (off) | Model that reviews each turn, e.g. `opus` |
| `rulesFile` | empty | Absolute path to your own rules file (a project's `.claude/token-optimiser-rules.json` is read either way) |
| `protectBranch` | empty (off) | Branch whose pushes are refused |
| `pushNote` | empty | Why, shown to Claude when it refuses |
| `mountGuardPath` | empty (off) | Path fragment of the compose folder to guard, e.g. `deploy/compose/` |

The main-loop models must be full ids; the engine refuses an alias such as `haiku` there.

### omp

`~/.omp/agent/token-optimiser.json`; every key is optional.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | Switch the extension off without removing it |
| `tiers` | Haiku 5.5, Sonnet 5.5, Opus 5.5 | Tier to model, as `provider/id` |
| `quotaGuard` | `{ "enabled": true, "holdHeavyAt": 0.7, "lightOnlyAt": 0.9 }` | As above, as fractions |
| `subagents` | built-in table | Agent type to tier; replaces the table |
| `mcpHints` | `{}` | MCP server to a pattern. When a prompt matches and the server is switched off, you are told once how to turn it on |

## The other savers (Claude Code)

- **Trimmed output.** Bash output over `trimChars` characters keeps its head and tail; the full text is saved to `/tmp/token-optimiser/<id>.txt` and the output names the file, so Claude reads the middle only when it needs it.
- **`token-optimiser:scout`.** A read-only search agent on Haiku that answers with `path:line` hits instead of file dumps; a short system-prompt note tells Claude to send searches there.
- **Hashline edits (an experiment).** `HashRead` tags each line `LINE:HASH|text`; `HashEdit` changes lines by those anchors instead of retyping the old text and refuses stale anchors. `/tokens hashline on|off` switches it from the next session, and `/tokens` compares output tokens per turn with it on and off.
- **Checks after each edit.** A fast checker for the file type runs and its errors reach Claude with the result: `ruff` (syntax errors and undefined names) for Python, `bash -n` for shell, a JSON parse for `.json`. A checker that is not installed stays silent.
- **Pattern rules.** A JSON array of rules from `rulesFile` and from a project's `.claude/token-optimiser-rules.json`. A tool-call rule matches what a call runs or writes and is handed to Claude with the result, or refuses the call with `block: true`. A stream rule (`"stream": true`) stops Claude's reply where it matches and hands it the rule.

  ```json
  [
    { "name": "no-latest", "match": ":latest\\b", "rule": "Pin images to a sha tag, never :latest.", "block": true },
    { "tool": "Bash", "match": "\\bnpm install\\b", "rule": "This repo uses pnpm." },
    { "name": "no-leak", "match": "Box::leak", "rule": "Don't reach for Box::leak in production code.", "stream": true }
  ]
  ```

- **Advisor** (off by default). Name a model in `advisorModel` and it reads each finished turn; a concern goes back to the agent before it stops. One extra request per turn.
- **Guards** (off by default). `protectBranch` refuses `git push` to a branch you name; prefix a push you asked for with `TOKEN_OPTIMISER_ALLOW_PUSH=1`. `mountGuardPath` refuses relative single-file bind mounts in compose YAML under a folder; end a line with `# token-optimiser: file-mount-ok` to allow one.

## Limits

- Savings shown by `/tokens` for trimmed output are estimates (4 characters per token).
- Claude Code reports the session model's context window whichever model a request runs on.
- On an API key the quota guard does nothing: there is no 7-day limit to read.
- In omp, without the `compaction.modelThresholds` setting above, a move to Haiku 5.5 above 100,000 tokens of context triggers compaction.
- No before-and-after cost figure is published yet.

## Layout

```
core/    the routing rules: pure functions, no host code
omp/     the omp extension
hooks/   the Claude Code mod
tests/   Claude Code tests (claude plugin test)
```

## Develop

```
bun test core omp
claude plugin test .
claude plugin validate .
```

## License

MIT, see [LICENSE](LICENSE).
