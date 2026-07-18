# ocask v0.1 — OpenCode Analytical Scrutiny Kit

Provider-agnostic review and analysis CLI for paid models. Delegates
analytical tasks — code review, architecture audit, security analysis,
TDD compliance, maintainability assessment — to DeepSeek V4 Pro,
Qwen 3.7, or OpenCode Go through three pluggable backends.

ocask = **O**pen**C**ode **A**nalytical **S**crutiny **K**it.

Designed as the analytical brain for multi-model orchestration pipelines:
a host (Claude, CI) sends heavy analytical work to DeepSeek via `ocask`
while reserving its own tokens for orchestration only.

## Install

**Prerequisites:** Node.js ≥ 20. For the OpenCode provider: `opencode` on PATH.

```bash
git clone https://github.com/anthonykewl20/ocask.git
cd ocask
./install.sh
```

The installer handles: CLI symlink, Claude Code skill (`/ocask`), OpenCode
slash command, and provider auth check. Re-run any time to refresh.

### Manual install

```bash
ln -s "$(pwd)/ocask.mjs" ~/.local/bin/ocask                               # CLI
mkdir -p ~/.claude/skills/ocask && cp skill/SKILL.md ~/.claude/skills/ocask/  # skill
mkdir -p ~/.config/opencode/commands && cp commands/ocask.md ~/.config/opencode/commands/  # command
```

### Auth setup per provider

| Provider | Auth method | Models |
|----------|-------------|--------|
| `deepseek` | `DEEPSEEK_API_KEY` env var, or `~/.deepseek-key` (mode 0600, one line) | DeepSeek V4 Pro, V4 Flash, Chat, Reasoner |
| `qwen` | `QWEN_API_KEY` env var, or `~/.qwen-key` (mode 0600, one line) | Qwen 3.7 Plus/Max, 3.6 Plus/Pro |
| `opencode` | `opencode providers login` (picks up existing CLI auth) | Routes via `deepseek/` and `alibaba/` provider prefixes |

For Qwen via OpenCode CLI: get an API key from https://home.qwencloud.com/api-keys and run `opencode providers login alibaba`.

For Alibaba Token Plan billing: set `QWEN_TOKEN_PLAN=1`.

Verify:

```bash
ocask --model deepseek-v4-pro --task "Reply: VERDICT: APPROVED. Test." --require-verdict
```

## Quick start

```bash
# Code review of current branch diff
git diff main | ocask --model deepseek-v4-pro --task - --require-verdict --lens code-review

# Architecture audit from a diff file
ocask --model deepseek-v4-pro --task ./changes.patch --require-verdict --lens architecture

# Native DeepSeek API (bypasses OpenCode CLI entirely)
ocask --model deepseek-v4-pro --provider deepseek --task ./diff.patch --require-verdict

# Native Qwen token plan
QWEN_TOKEN_PLAN=1 ocask --model qwen3.7-plus --provider qwen --task ./diff.patch --require-verdict

# Thermo-nuclear maintainability review
ocask --model deepseek-v4-pro --task ./feature.diff --require-verdict --lens maintainability

# Deep-module interface audit
ocask --model deepseek-v4-pro --task ./src/ --require-verdict --lens deep-modules

# JSON output, no fallback (gated review)
ocask --model deepseek-v4-pro --task ./diff.patch --json --require-verdict --lens security --no-fallback
```

## Usage

```
ocask --model <id>
      --task <path|-|string>
      [--provider opencode|deepseek|qwen]
      [--context <path|-|string>]
      [--lens code-review|architecture|security|tdd|maintainability|deep-modules|general]
      [--require-verdict]
      [--no-fallback]
      [--panel]
      [--risk auto|trivial|default|high]
      [--json]
      [--metadata <path>]
      [--timeout-ms N]
      [--max-tokens N]
```

| Flag | Default | Purpose |
|------|---------|---------|
| `--model` | (required) | Short model ID: `deepseek-v4-pro`, `qwen3.7-plus`, etc. |
| `--task` | (required) | Path to file, `-` for stdin, or inline string |
| `--provider` | auto-detect | Backend transport: `opencode`, `deepseek`, `qwen` |
| `--context` | — | Additional context file or text |
| `--lens` | `general` | Audit framework to inject into the prompt |
| `--require-verdict` | off | Enforce APPROVED/WARNING/BLOCKED contract |
| `--no-fallback` | off | Pin model identity via the trust table; transport fallback only across same-weights transports |
| `--panel` | off | Cross-family consensus panel (DeepSeek + Qwen), K-of-N majority |
| `--risk` | `auto` | Panel risk tier (with `--panel`): `trivial`→solo check, `default`/`high`→panel |
| `--json` | off | JSON object output (not prose) |
| `--metadata` | — | Path for privacy-safe attempt report (mode 0600) |
| `--timeout-ms` | 170000 | Per-run absolute deadline (300000 hard ceiling; review ops up to 900000) |
| `--max-tokens` | — | Advisory response token limit |

## Models

| Model | ID | Default provider |
|-------|-----|------------------|
| DeepSeek V4 Pro | `deepseek-v4-pro` | `deepseek` |
| DeepSeek V4 Flash | `deepseek-v4-flash` | `deepseek` |
| DeepSeek Chat | `deepseek-chat` | `deepseek` |
| DeepSeek Reasoner | `deepseek-reasoner` | `deepseek` |
| Qwen 3.7 Plus | `qwen3.7-plus` | `qwen` |
| Qwen 3.7 Max | `qwen3.7-max` | `qwen` |
| Qwen 3.6 Plus | `qwen3.6-plus` | `qwen` |

Auto-detection: `deepseek-*` models → deepseek provider, `qwen*` models → qwen provider.

## Review lenses

Each lens injects a structured audit framework tailored to DeepSeek's
analytical reasoning strength:

| Lens | Source | Focus |
|------|--------|-------|
| `code-review` | Fowler + Pocock | 12 code smells, correctness, completeness, consistency |
| `architecture` | Ousterhout + Feathers | Deep vs shallow modules, seams, deletion test, coupling |
| `security` | OWASP-derived | Injection, auth, data exposure, privilege, supply chain |
| `tdd` | Pocock | Test-contract alignment, tautological/implementation-coupled/horizontal-slicing anti-patterns |
| `maintainability` | Cursor thermo-nuclear | Code judo, 1K-line boundary, spaghetti detection, approval bar |
| `deep-modules` | Pocock codebase-design | Interface audit, seam placement, shallow detection, adapter discipline |
| `general` | — | Unstructured chain-of-thought analytical review |

## Architecture

```
ocask (Node.js CLI)
  │
  ├─ buildPrompt()              — assembles prompt with lens framework + execution guidance
  ├─ runAsk()                   — model-level fallback, wired to logging
  │   └─ invokeWithFallback()
  │       │
  │       ├─ providers/deepseek.mjs  — POST api.deepseek.com/v1/chat/completions
  │       ├─ providers/qwen.mjs      — POST dashscope-intl.aliyuncs.com/compatible-mode/v1
  │       └─ providers/opencode.mjs  — opencode run --pure (deepseek/ for DS, alibaba/ for Qwen)
  │
  ├─ validateAssistantOutput()   — enforces verdict contract, JSONL parsing
  ├─ logging.mjs                 — JSONL observability (~/.local/share/ocask/log.jsonl)
  │   ├─ doctor                  — provider health, flake detection, error suggestions
  │   └─ diagnose                — per-run root cause + timeline
  └─ pricing.mjs                 — rates, cost calculation, --refresh from provider APIs
```

- **Lazy-loaded providers** — no provider is loaded until needed.
- **Two-layer fallback** — provider chain (transport) + model chain (output quality).
- **Structured logging** — every invocation tracked with token usage for cost analysis.
- **Subcommands** — `ocask doctor`, `ocask diagnose`, `ocask cost`, `ocask pricing`, `ocask help`.
- **Classified errors** — AUTH_FAILURE, RATE_LIMITED, TIMEOUT, CONNECTION_ERROR, MALFORMED_RESPONSE, ENTITLEMENT_UNAVAILABLE.

See [ARCHITECTURE.md](ARCHITECTURE.md) for full design rationale, sad-path handling, security model, and configuration.

## Fallback behavior

Two independent layers:

1. **Provider level** — when a transport fails with a retryable error
   (rate limit, auth, timeout, connection), the next provider in the chain
   is tried: `deepseek → qwen → opencode` (configurable).

2. **Model level** — when output is malformed (missing verdict,
   numbers-only), the opposite-family model retries once:
   `deepseek-v4-pro → qwen3.7-plus` or `qwen3.7-plus → deepseek-v4-flash`.
   Only for `--require-verdict` tasks (read-only, safe to replay).

Use `--no-fallback` for mandatory audit gates where the primary model's
verdict is the acceptance requirement. Under `--no-fallback`, ocask pins model
**identity** via a curated trust table — transport fallback still proceeds
across declared same-weights transports (e.g. DeepSeek's native API and the
OpenCode CLI route), but a DeepSeek model never routes to the Qwen provider.

## Consensus verify-panel

`--panel` replaces the single-model verdict with a **cross-family consensus
panel** — the requested model plus its opposite-family counterpart
(DeepSeek ↔ Qwen). Every member runs the same task under one shared absolute
deadline, then the verdicts combine:

- **K-of-N majority** — for the default two-member panel, both members must
  agree (`K = 2`). With no majority, a conservative tiebreaker applies: any
  `BLOCKED` vote blocks the run, otherwise the result is `WARNING`.
- **Abstention ≠ dissent** — a member that returns no usable verdict (timeout,
  auth failure, malformed reply) is an **abstention**, not a vote. Too many
  abstentions to reach quorum fail closed to **no-judgment** (exit 30) rather
  than a false agreement.

`--risk auto|trivial|default|high` (default `auto`) selects how much scrutiny a
task gets:

| `--risk` | Behavior |
|----------|----------|
| `trivial` | Solo check — the primary model alone, no panel |
| `default` | Two-member cross-family panel |
| `high` | Panel with identity pinning (`--no-fallback` implied) and a combined `security` + `code-review` + `architecture` lens set |
| `auto` | Detect from a unified-diff `--context`: small/clean diffs → `trivial`, sensitive paths (`auth`, `crypto`, `payment`, `migrat`, …) or large diffs → `high`, else `default`; non-diff context → `default` |

```bash
# Two-member panel, risk auto-detected from the diff
git diff main | ocask --model deepseek-v4-pro --task - --require-verdict --panel --lens code-review

# Force the highest scrutiny: pinned identity + security/code/architecture lenses
ocask --model deepseek-v4-pro --task ./auth.diff --require-verdict --panel --risk high
```

Panel runs are review ops, so they may use up to the 900000ms timeout ceiling,
and that deadline is shared across all members (see the `--timeout-ms` row
above).

## Observability

ocask logs every invocation to `~/.local/share/ocask/log.jsonl` (JSONL,
auto-rotates at 10MB). Use these subcommands to inspect:

```bash
# Provider health, flake detection, error suggestions
ocask doctor

# Deep-dive a specific run
ocask diagnose --run-id <id>

# Cumulative cost across all runs
ocask cost

# Cost of a specific run
ocask cost --run-id <id>

# Cost with refreshed pricing from provider APIs
ocask cost --refresh

# Current pricing table
ocask pricing

# Fetch latest pricing from providers
ocask pricing --refresh

# Check for new version
ocask upgrade
```

Each invocation logs: model, provider, lens, attempt chain (which providers
tried, what errors, durations), token usage, verdict, and root cause for
failures. The doctor reports per-provider health as **PASS/WARN/FAIL** (a 401
connectivity probe is WARN, not a green ✓), detects flakes (intermittent
failures that recover on retry), high-latency providers (excluding censored,
timed-out runs), and auth/rate-limit patterns. Cause attribution follows the
**entailment rule**: a cause is named only when the failure record entails it —
routing on the true `mechanism` and `locus` — otherwise it reports
`undetermined` plus the observed symptom, so a hang is never misdiagnosed as
missing credentials, and a hang's advice never tells you to raise the timeout.

## Configuration

| Env var | Provider | Purpose |
|---------|----------|---------|
| `DEEPSEEK_API_KEY` | `deepseek` | API key (primary; overrides key file) |
| `QWEN_API_KEY` | `qwen` | API key (primary; overrides key file) |
| `QWEN_TOKEN_PLAN` | `qwen` | Set `1` for Alibaba Token Plan billing mode |
| `OCASK_DISABLE_SERVER` | `opencode` | Set `0` to re-enable persistent server (direct mode is default) |
| `XDG_DATA_HOME` | all | Base for log and pricing cache (default: `~/.local/share/ocask/`) |

Key files (fallback, read once per invocation):

- `~/.deepseek-key` — mode 0600, one trimmed line
- `~/.qwen-key` — mode 0600, one trimmed line

## Tests

```bash
node --test ocask.test.mjs
./check.sh         # verify all docs, skill, install are in sync
```

45 unit tests. 96 sync checks across code, architecture doc, README, skill,
slash command, and installer. CI runs `node --test` on every PR and push to `main`.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the test
commands, and the pull-request workflow (`main` is protected and requires a green CI check).
Security issues: please follow [SECURITY.md](SECURITY.md), not a public issue. Release process:
[RELEASING.md](RELEASING.md); user-facing changes: [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.

```
Copyright 2026 Anthony Garces
Licensed under the Apache License, Version 2.0.
```
