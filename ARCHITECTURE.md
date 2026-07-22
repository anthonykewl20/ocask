# ocask Architecture

A provider-agnostic review and analysis CLI that delegates analytical tasks
to paid models (DeepSeek, Qwen, OpenCode Go). Designed for multi-model
orchestration pipelines where a host (Claude) delegates heavy analytical
work to DeepSeek and small mechanical tasks to GLM.

## System Design

```
                         ┌─────────────────┐
   Host (Claude / CI) ──►│   ocask.mjs     │
                         │  CLI + Subcommands│
                         └────────┬────────┘
                                  │ invokeWithFallback()
                  ┌───────────────┼───────────────┐
                  │               │               │
           ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
           │  deepseek    │ │    qwen     │ │  opencode   │
           │  API provider│ │ API provider│ │ CLI provider│
           └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
                  │               │               │
           ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
           │ api.deepseek │ │ dashscope   │ │ deepseek/    │
           │    .com      │ │  .aliyuncs  │ │ alibaba/     │
           └──────────────┘ └─────────────┘ │ prefix route │
                                     └─────────────┘

Observability (every invocation):
  runAsk ──► logging.mjs ──► ~/.local/share/ocask/log.jsonl
                  │
            ┌─────┴──────┐
      doctor (health)  cost (pricing.mjs)
     diagnose (root    pricing (rates)
      cause)          cumulative spend
```

## Layers

### 1. CLI & Subcommands (`ocask.mjs`)

The entry point dispatches subcommands:

| Command | Purpose |
|---------|---------|
| `ocask [args]` | Run a review (default — prompt assembly, provider invocation, output validation) |
| `ocask doctor` | Provider health dashboard, flake detection, error suggestions |
| `ocask diagnose --run-id <id>` | Deep-dive a specific invocation: timeline, root cause |
| `ocask cost` | Cumulative cost from log (per-model breakdown) |
| `ocask cost --run-id <id>` | Cost of a specific run |
| `ocask pricing` | Current pricing table (USD/MTok for all models) |
| `ocask pricing --refresh` | Fetch latest pricing from provider APIs |
| `ocask help` | Full usage |

### 2. Prompt Assembly (`ocask.mjs` — `buildPrompt`)

Takes raw task text + context + lens and produces a structured prompt
optimized for analytical reasoning models. Three components:

- **Task body** — user-supplied review target (diff, file paths, question)
- **Lens framework** — domain-specific audit checklist injected per `--lens` (7 lenses: `code-review`, `architecture`, `security`, `tdd`, `maintainability`, `deep-modules`, `general`)
- **Execution guidance** — chain-of-thought instruction, evidence inspection, structural simplification
- **Response contract** — `VERDICT: APPROVED | WARNING | BLOCKED` with structured rationale

### 3. Provider Abstraction (`providers/factory.mjs`)

The factory lazily loads three backends sharing a unified contract:

```javascript
export async function invoke({ model, prompt, timeoutMs, env, cwd })
  → { stdout, stderr, provider, model_used, tokensUsed }
  throws ProviderError { code }
```

- `tokensUsed`: `{ input: number, output: number, total: number }` — enables cost tracking
- Providers are loaded dynamically (no static imports) so missing dependencies
  (e.g. no OpenCode CLI) don't block the factory from loading.

**Provider error codes:**

| Code | Meaning | Retryable? |
|------|---------|-----------|
| `AUTH_FAILURE` | Bad/missing API key | Yes |
| `RATE_LIMITED` | 429, quota exceeded | Yes |
| `TIMEOUT` | Request timed out | Yes |
| `PROVIDER_ERROR` | Generic 5xx | Yes |
| `CONNECTION_ERROR` | DNS/TCP failure | Yes |
| `MODEL_NOT_FOUND` | Unknown model | Yes |
| `INSUFFICIENT_BALANCE` | Qwen billing (402) | Yes |
| `MALFORMED_RESPONSE` | Invalid response shape | **No** |
| `ENTITLEMENT_UNAVAILABLE` | Key classification mismatch | **No** |
| `INTERRUPTED` | SIGINT/SIGTERM | **No** |
| `ALL_PROVIDERS_EXHAUSTED` | All backends failed | **No** (terminal) |

### 4. Provider Implementations

#### `deepseek` — Native DeepSeek API
- POST `https://api.deepseek.com/v1/chat/completions`
- Auth: `DEEPSEEK_API_KEY` env var or `~/.deepseek-key` (mode 0600)
- Maps `deepseek-v4-pro` → `deepseek-chat`, `deepseek-v4-flash` → `deepseek-chat`
- Returns `tokensUsed` from `body.usage`

#### `qwen` — Native Alibaba DashScope API
- POST `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
- Auth: `QWEN_API_KEY` env var or `~/.qwen-key` (mode 0600)
- Token Plan: set `QWEN_TOKEN_PLAN=1` for `x-dashscope-plugin` header
- Maps `qwen3.7-plus` → `qwen-plus`, `qwen3.7-max` → `qwen-max`
- Handles both OpenAI-compatible (`choices[0].message`) and DashScope-native (`output.text`) response formats
- Returns `tokensUsed` from `body.usage`

#### `opencode` — OpenCode CLI
- Invokes `opencode run --pure --auto --format json`
- Provider prefix routing: DeepSeek models → `deepseek/`, Qwen models → `alibaba/`
- Adds `--variant max` for DeepSeek models
- Default: direct one-shot mode (no persistent server). Opt-in with `OCASK_DISABLE_SERVER=0`
- Prompt via stdin, output parsed as JSONL via `parseOpenCodeJsonl`

### 5. Fallback Chain

Two independent layers:

1. **Provider-level** (`invokeWithFallback` in factory): transport failures
   (rate limit, auth, timeout, connection) try the next provider:
   ```
   deepseek → qwen → opencode
   ```
   Configurable per provider family.

2. **Model-level** (`runAsk` in ocask.mjs): malformed output (missing verdict,
   numbers-only → `MODEL_OUTPUT`) first retries the **same** model up to
   `MODEL_OUTPUT_RETRIES` (2) times — such abstentions are largely transient (#45)
   — and only then retries the opposite model family once. Same-model retries are
   deadline-bounded and apply even under `--no-fallback` (same exact model, never a
   switch); the opposite-family retry stays gated by `--no-fallback`. Only for
   `--require-verdict` tasks (read-only, safe to replay).

**Identity pinning (`--no-fallback`).** `--no-fallback` pins the model's
*identity*, not a transport. The factory carries a curated **identity trust
table** (`IDENTITY_TRANSPORT_TRUST` in `factory.mjs`): a human-asserted
declaration of which transports serve the same weights
(`deepseek-v4-pro → {deepseek, opencode}`, `qwen3.7-plus → {qwen, opencode}`).
Under the pin the resolver admits only the native family transport or an
explicitly declared same-weights transport, so a DeepSeek model can fall back
from the native API to the OpenCode CLI route but never to the Qwen provider
(hard reject via `providerSupportsModel` + `isIdentityPreservingTransport`).
Each run records `identity_preserved` in its metadata. The table is a
*declaration*, not a cryptographic verification: a non-null `snapshotId` would
be the wire model ID and supersede the mutable alias; today every entry is
`vendor-exposes-no-snapshot`, so equivalence rests on the declaration.

### Consensus Panel (`ocask.mjs` — `runPanel`)

`--panel` elevates a single verdict to a **cross-family consensus panel**: the
requested model plus its opposite-family counterpart (DeepSeek ↔ Qwen, resolved
through the trust table above). All members share **one absolute deadline** —
the budget is not per-attempt; primary, fallback, and every panel member draw
from the same clock, so a slow member cannot extend the run past the ceiling.

Consensus is fail-closed by construction:

- **K-of-N majority.** Quorum is `k = ⌊N/2⌋ + 1` — for the two-member panel,
  both members must agree. With no majority, a conservative tiebreaker applies:
  any `BLOCKED` vote blocks the run, otherwise the verdict is `WARNING`.
- **Abstention ≠ dissent.** A member counts as a judgment only when its
  classification is `judgment` *and* it carries a canonical verdict. Anything
  else — timeout, auth failure, malformed reply, no verdict — is an
  **abstention**, not a vote. If judgments fall below quorum, the panel returns
  **no-judgment** (`PANEL_QUORUM_FAILURE`, exit 30) rather than agreeing on the
  survivors. A panel can therefore never report a false consensus.

Risk selection (`--risk`) chooses the panel shape: `trivial` → a solo check
(no panel), `default`/`high` → the cross-family panel, and `high` additionally
pins identity and applies a combined `security` + `code-review` + `architecture`
lens set to each member. `auto` classifies a unified-diff `--context` to pick.

**Absolute-deadline model.** The default timeout is 170000ms (measured P95)
with a 300000ms hard ceiling, enforced as a single absolute deadline shared
across primary + fallback + cross-verify + panel. Review/analysis ops
(`--require-verdict`, `--panel`, `--lens`) may raise the ceiling to 900000ms;
plain delegation stays capped at 300000ms. A timed-out run records
`duration_censored: true` so its duration is excluded from latency statistics.

### 6. Output Validation (`ocask.mjs` — `validateAssistantOutput`)

- Text + verdict: one or more explicit `VERDICT: APPROVED|WARNING|BLOCKED`
  lines anywhere in the response + alphabetic rationale. Repeated verdicts must
  agree, except that any `BLOCKED` candidate resolves to `BLOCKED` before the
  agreement check so a safety finding cannot be outvoted.
- JSON + verdict: `{ verdict, reason|reasoning|summary }` single object
- All modes: must contain alphabetic content (not numbers-only)

The text rule deliberately ignores verdict placement because placement carries
no review-quality signal. The measured log held 944 `MODEL_OUTPUT` records. The
reported breakdown accounted for 942 of them: 343 were rejected for not
containing exactly one verdict line, 21 because the verdict appeared after the
fifth nonempty line, 537 were JSON parse failures, and 41 had no message. On
2026-07-20 through 2026-07-22, every field `MODEL_OUTPUT` was one of the two
cosmetic text-verdict rejections. Accepting consistent repetitions and verdicts
at any line preserves completed reviews while missing verdicts, conflicting
non-`BLOCKED` verdicts, and reviews without prose still fail closed.

### 7. Observability (`logging.mjs`)

Every `runAsk` invocation writes structured events to
`~/.local/share/ocask/log.jsonl`:

| Event | Trigger | Data |
|-------|---------|------|
| `run.start` | Invocation begins | model, lens, provider, prompt_hash, input_bytes |
| `attempt.result` | Each provider attempt | provider, model, outcome, duration_ms, reason_code, tokens_used |
| `fallback` | Model-level fallback | from_model → to_model, provider chain, reason |
| `verdict` | Review completes | verdict, model, lens, duration_ms |
| `error` | Terminal failure | error_code, error_class, attempts_exhausted |

Log file auto-rotates at 10MB (keeps 2 backups).

**Doctor** (`ocask doctor`): reads the log and produces:
- Provider health: PASS/WARN/FAIL per provider/model — success rate, avg latency
  (censored timed-out runs excluded), and error breakdown. A connectivity probe
  that returns 401 is WARN, not a pass.
- Flake detection: intermittent failures that recover on retry (same run)
- Top errors: most common error codes with counts
- Suggestions: high-severity anomalies (low success rate, auth failures, timeouts)

**Entailment rule.** The doctor names a *cause* only when the failure record
*entails* it — it routes on the true `mechanism` and `locus`, never on a
collapsed wrapper. When the record does not entail a specific cause, it reports
`undetermined` alongside the observed symptom. This is why a timeout is no
longer misdiagnosed as "no credentials": a hang (timed out, censored, duration
≥ 2× the healthy p99) is attributed to the provider, and its advice explicitly
says *not* to raise `--timeout-ms`.

**Diagnose** (`ocask diagnose --run-id <id>`): for a specific run:
- Full attempt chain with durations and error codes
- Fallback history
- Timeline of events
- Root cause inference (single vs. multiple failure modes)

### 8. Cost Tracking (`pricing.mjs`)

Baseline pricing embedded for all supported models (updated 2026-07-17).
`--refresh` fetches the latest from `api.deepseek.com/pricing` (24h cache).

Cost calculation: `(input_tokens / 1M) * rate.input + (output_tokens / 1M) * rate.output`

Token data flows: provider → `tokensUsed` → `logAttemptResult` → log.jsonl → cost calculator.

## Sad Paths & Edge Cases

### Auth Failures
- Env var not set, key file missing → `AUTH_FAILURE`. Provider skipped.
- Key expired/revoked → API 401/403 → `AUTH_FAILURE`. Retryable on next provider.
- OpenCode Go key Lite-tier → `ENTITLEMENT_UNAVAILABLE`. Not retryable.

### Rate Limiting
- 429 with Retry-After → `RATE_LIMITED`. Provider skipped.
- Quota exhausted → `RATE_LIMITED` or `INSUFFICIENT_BALANCE` (Qwen 402). Provider skipped.
- All providers exhausted → `ALL_PROVIDERS_EXHAUSTED` with attempt history.

### Network & Transport
- DNS/TCP/TLS failure → `CONNECTION_ERROR`. Retryable.
- Request timeout → `TIMEOUT`. Retryable (submission may have started — caller ensures idempotency).
- Truncated JSON → `MALFORMED_RESPONSE`. NOT retryable (double-fire risk).

### Response Quality
- Empty, numbers-only, missing verdict, conflicting non-`BLOCKED` verdicts,
  rationale-free reviews, unparseable JSON →
  `MODEL_OUTPUT`. Eligible for opposite-family model retry.

### Log Integrity
- Log corruption: malformed lines are skipped on read (JSONL — each line is independent).
- Rotation: atomic rename, keeps 2 old files.
- Privacy: logs contain only event metadata (codes, counts, hashes). Never raw
  prompt, output, credentials, paths, or session IDs.

## Security Model

### API Keys
- Never in argv, prompt text, metadata reports, or log files.
- Key files (`~/.deepseek-key`, `~/.qwen-key`): mode 0600, non-symlink, user-owned.
- Env vars (`DEEPSEEK_API_KEY`, `QWEN_API_KEY`): in-process only, never serialized.
- OpenCode CLI: auth via `opencode providers login`.

### Logs
- `~/.local/share/ocask/log.jsonl`: mode 0600. Privacy-safe: event codes,
  token counts, durations, hashes. No raw content, paths, or secrets.
- Pricing cache: mode 0600. Only numeric rates, no keys.

### Metadata Reports (`--metadata`)
- Mode 0600, atomic write (rename after fsync).
- Contains: model, attempts, durations, reason codes, byte counts, exit status.
- NEVER: prompts, responses, provider text, argv, env values, source text.

## Configuration

| Env var | Provider | Purpose |
|---------|----------|---------|
| `DEEPSEEK_API_KEY` | `deepseek` | API key (overrides key file) |
| `QWEN_API_KEY` | `qwen` | API key (overrides key file) |
| `QWEN_TOKEN_PLAN` | `qwen` | Set `1` for Alibaba Token Plan billing |
| `OCASK_DISABLE_SERVER` | `opencode` | Set `0` to re-enable persistent server |
| `XDG_DATA_HOME` | all | Base for `~/.local/share/ocask/` (log, pricing cache) |

Key files: `~/.deepseek-key`, `~/.qwen-key` (mode 0600, one trimmed line).

## Project Structure

```
ocask/
├── ocask.mjs                 # CLI entry, subcommand dispatch, prompt builder,
│                             #   output validation, runAsk, runMain
├── logging.mjs               # JSONL observability (log, doctor, diagnose)
├── pricing.mjs               # Pricing tables, cost calc, dynamic refresh
├── ocverify.mjs              # Paid model guard
├── providers/
│   ├── factory.mjs           # Lazy-loaded provider registry, fallback chain
│   ├── deepseek.mjs          # Native DeepSeek API (fetch)
│   ├── qwen.mjs              # Native Alibaba DashScope API (fetch)
│   └── opencode.mjs          # OpenCode CLI (child_process spawn)
├── ocask.test.mjs            # 23 unit tests
├── skill/SKILL.md            # Claude Code skill
├── ARCHITECTURE.md           # This document
└── README.md                 # User-facing docs
```
