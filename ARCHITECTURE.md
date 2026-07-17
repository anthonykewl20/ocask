# ocask Architecture

A provider-agnostic review and analysis CLI that delegates analytical tasks to paid models (DeepSeek, Qwen, OpenCode Go). Designed for multi-model orchestration pipelines where a host (Claude) delegates heavy analytical work to DeepSeek and small mechanical tasks to GLM.

## System Design

```
                        ┌─────────────────┐
  Host (Claude / CI) ──►│   ocask.mjs     │
                        │  CLI + Prompts  │
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
          │ api.deepseek │ │ dashscope   │ │  opencode   │
          │    .com      │ │  .aliyuncs  │ │  run --pure │
          └──────────────┘ └─────────────┘ └─────────────┘
```

## Layers

### 1. Prompt Assembly (`ocask.mjs`)

Takes raw task text + context + lens and produces a structured prompt optimized for analytical reasoning models. Three components:

- **Task body** — user-supplied review target (diff, file paths, question)
- **Lens framework** — domain-specific audit checklist injected per `--lens`:
  - `code-review` — Fowler's 12 code smells
  - `architecture` — deep/shallow modules, seams, deletion test, coupling
  - `security` — injection, auth, exposure, supply chain
  - `tdd` — test-contract alignment, anti-patterns
  - `maintainability` — thermo-nuclear: code judo, 1K-line boundary, spaghetti detection
  - `deep-modules` — interface audit, seam placement, adapter discipline
  - `general` — unstructured chain-of-thought review
- **Execution guidance** — "Think step by step, inspect evidence deeply, cite specific patterns, be ambitious about structural simplification."
- **Response contract** — `VERDICT: APPROVED | WARNING | BLOCKED` with structured rationale

### 2. Provider Abstraction (`providers/factory.mjs`)

The factory abstracts over three backends with a unified interface:

```javascript
// Provider contract
export async function invoke({ model, prompt, timeoutMs, env, cwd })
  → { stdout, stderr, provider, model_used }
  throws ProviderError { code }
```

Provider error codes are classified so the fallback chain can make retry decisions:

| Code | Meaning | Retryable? |
|------|---------|-----------|
| `AUTH_FAILURE` | Bad/missing API key | Yes (try next provider) |
| `RATE_LIMITED` | 429, quota exceeded | Yes (try next provider) |
| `TIMEOUT` | Request timed out | Yes (try next provider) |
| `PROVIDER_ERROR` | Generic 5xx | Yes (try next provider) |
| `CONNECTION_ERROR` | DNS/TCP failure | Yes (try next provider) |
| `MODEL_NOT_FOUND` | Unknown model | Yes (try next provider) |
| `MALFORMED_RESPONSE` | Invalid response shape | **No** (model responded — retry replays) |
| `ENTITLEMENT_UNAVAILABLE` | Key classification mismatch | **No** (retrying the same key is pointless) |
| `INTERRUPTED` | SIGINT/SIGTERM | **No** (user cancelled) |
| `ALL_PROVIDERS_EXHAUSTED` | All backends failed | **No** (terminal) |

### 3. Provider Implementations

#### `opencode` — OpenCode CLI
- Invokes `opencode run --pure --auto --model <provider>/<model> --format json`
- Adds `--variant max` for DeepSeek models
- Default: direct one-shot mode (no persistent server). Re-enable with `OCASK_DISABLE_SERVER=0`.
- Prompt sent via stdin, output parsed as JSONL

#### `deepseek` — Native DeepSeek API
- POST `https://api.deepseek.com/v1/chat/completions`
- Auth: `DEEPSEEK_API_KEY` env var or `~/.deepseek-key` file
- Maps ocask model IDs (`deepseek-v4-pro`) to API model IDs (`deepseek-chat`)
- Classification: 401/403 → AUTH, 429 → RATE_LIMITED, 404 → MODEL_NOT_FOUND, 5xx → PROVIDER_ERROR

#### `qwen` — Native Alibaba DashScope API
- POST `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
- Auth: `QWEN_API_KEY` env var or `~/.qwen-key` file
- Token Plan support: set `QWEN_TOKEN_PLAN=1` to add `x-dashscope-plugin` header
- Maps ocask model IDs (`qwen3.7-plus`) to API model IDs (`qwen-plus`)
- Classification: 401/403 → AUTH, 429 → RATE_LIMITED, 402 → INSUFFICIENT_BALANCE, 5xx → PROVIDER_ERROR
- Handles both OpenAI-compatible and DashScope-native response formats

### 4. Fallback Chain

When a provider fails with a retryable error, the factory tries the next provider in the chain:

```
Primary: deepseek-v4-pro → deepseek provider
                         ↓ (rate limited)
                    → qwen provider
                         ↓ (also unavailable)
                    → opencode provider
```

Chains are configurable per provider family:
```
deepseek: [deepseek, qwen, opencode]
qwen:     [qwen, deepseek, opencode]
opencode: [opencode, deepseek, qwen]
```

Two layers of fallback:
1. **Provider-level** (`invokeWithFallback`): handles transport failures (auth, rate limit, timeout, connection)
2. **Model-level** (`runAsk`): handles malformed responses by retrying the opposite model family (DeepSeek→Qwen, Qwen→DeepSeek). Only for review tasks (`--require-verdict`) where replay is safe.

### 5. Output Validation

After the provider returns raw text, `validateAssistantOutput` enforces the response contract:

- Text mode + verdict: exactly one `VERDICT: APPROVED|WARNING|BLOCKED` line within first 5 lines + alphabetic rationale
- JSON mode + verdict: `{ verdict, reason|reasoning|summary }` single object
- All modes: must contain alphabetic content (not numbers-only)

## Sad Paths & Edge Cases

### Auth Failures
- **Env var not set, key file missing** → `AUTH_FAILURE` error. Provider is skipped in fallback chain.
- **Key expired/revoked** → API returns 401/403. Classified as `AUTH_FAILURE`, retryable on next provider.
- **OpenCode Go key is Lite-tier** → `ENTITLEMENT_UNAVAILABLE`. Not retryable (same key will fail again).

### Rate Limiting
- **429 with Retry-After** → `RATE_LIMITED` error. Provider skipped, next provider tried.
- **Quota exhausted** → `RATE_LIMITED` or `INSUFFICIENT_BALANCE` (Qwen-specific). Provider skipped.
- **All providers rate-limited** → `ALL_PROVIDERS_EXHAUSTED` with attempt history.

### Network & Transport
- **DNS resolution failure** → `CONNECTION_ERROR`. Retryable on next provider.
- **TCP connection refused** → `CONNECTION_ERROR`. Retryable.
- **TLS handshake failure** → `CONNECTION_ERROR`. Retryable.
- **Request timeout** → `TIMEOUT`. Retryable on next provider (submission may have started — caller must ensure idempotency).
- **Partial response (truncated JSON)** → `MALFORMED_RESPONSE`. NOT retryable (model received the prompt; retry would double-fire).

### Response Quality
- **Empty response** → `MODEL_OUTPUT`. Eligible for opposite-family retry at the model level (not provider level).
- **Numbers-only output** → `MODEL_OUTPUT`. Eligible for opposite-family retry.
- **Missing verdict line** → `MODEL_OUTPUT`. Eligible for opposite-family retry.
- **Verdict not within first 5 lines** → `MODEL_OUTPUT`. Eligible for opposite-family retry.
- **JSON not parseable** → `MODEL_OUTPUT`. Eligible for opposite-family retry.

### Billing
- **Alibaba Token Plan exhaustion** → `INSUFFICIENT_BALANCE` (402). Not generated by `deepseek` or `opencode` providers — those providers handle billing differently.
- **DeepSeek credit limit** → `RATE_LIMITED` (429) with quota-exceeded message.

### Concurrency
- **Multiple ocask processes** → Each is independent. No shared state between invocations (no persistent server by default).
- **OpenCode server conflict** → When `OCASK_DISABLE_SERVER=0` is set, ocask checks existing server health/PID/version before reusing. Version mismatch falls back to direct mode.
- **Key file race** → Atomic mode-0600 reads with `O_NOFOLLOW`.

### Interruption
- **SIGINT/SIGTERM during provider call** → `INTERRUPTED` error. NOT retryable. Child processes cleaned up.
- **Crash during response parsing** → State is lost (no partial writes). Caller must re-invoke.

## Security Model

### API Keys
- Keys never appear in argv, prompt text, or metadata reports.
- Key files (`~/.deepseek-key`, `~/.qwen-key`) must be mode 0600, non-symlink, user-owned.
- Env vars (`DEEPSEEK_API_KEY`, `QWEN_API_KEY`) are in-process only — never serialized.
- OpenCode CLI handles its own auth via `opencode providers login`.

### Metadata Reports (`--metadata`)
- Mode 0600, atomic write (rename after fsync).
- Contains only: model, attempts, durations, reason codes, byte counts, exit status, fallback/server mode.
- NEVER contains: prompts, responses, provider text, argv, env values, source text.

### Provider Response Stderr
- OpenCode CLI stderr is suppressed from error messages ("provider diagnostics suppressed").
- Native API providers include a usage summary in stderr (token counts only, no content).

## Configuration Model

| Env Var | Purpose |
|----------|---------|
| `DEEPSEEK_API_KEY` | DeepSeek API auth |
| `QWEN_API_KEY` | Alibaba DashScope auth |
| `QWEN_TOKEN_PLAN` | Enable Alibaba Token Plan billing |
| `OCASK_DISABLE_SERVER` | Set to `0` to re-enable persistent OpenCode server |
| `XDG_RUNTIME_DIR` | OpenCode server runtime directory (default: `/run/user/<uid>/ocask`) |

Key files: `~/.deepseek-key`, `~/.qwen-key` (mode 0600, one trimmed line each).

## Project Structure

```
ocask/
├── ocask.mjs                 # CLI entry, prompt builder, output validation, runAsk, runMain
├── ocask.test.mjs            # Unit tests
├── ocverify.mjs              # Paid model guard (shared with verify-panel)
├── providers/
│   ├── factory.mjs           # Provider selection, fallback chain, ProviderError
│   ├── opencode.mjs          # OpenCode CLI provider (child_process spawn)
│   ├── deepseek.mjs          # Native DeepSeek API provider (fetch)
│   └── qwen.mjs              # Native Qwen/Alibaba API provider (fetch)
├── ARCHITECTURE.md           # This document
└── README.md                 # User-facing docs
```
