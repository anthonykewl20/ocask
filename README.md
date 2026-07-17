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
chmod +x ocask.mjs

# Symlink to PATH
ln -s "$(pwd)/ocask.mjs" ~/.local/bin/ocask

# Install Claude Code skill (enables /ocask slash command)
mkdir -p ~/.claude/skills/ocask
cp skill/SKILL.md ~/.claude/skills/ocask/

# Install OpenCode command
mkdir -p ~/.config/opencode/commands
cp commands/ocask.md ~/.config/opencode/commands/
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
| `--no-fallback` | off | Pin exact model; disable opposite-family retry |
| `--json` | off | JSON object output (not prose) |
| `--metadata` | — | Path for privacy-safe attempt report (mode 0600) |
| `--timeout-ms` | 0 (none) | Timeout per provider attempt |
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
verdict is the acceptance requirement.

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
```

Each invocation logs: model, provider, lens, attempt chain (which providers
tried, what errors, durations), token usage, verdict, and root cause for
failures. The doctor detects flakes (intermittent failures that recover on
retry), high-latency providers, and auth/rate-limit patterns.

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
```

23 unit tests: args parsing, prompt building (all 7 lenses), output validation
(verdict, JSON, numeric), JSONL parsing, extractJsonObject, file/stdin input,
provider factory classification, and error codes.

## License

MIT
