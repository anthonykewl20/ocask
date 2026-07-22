---
name: ocask
description: Delegate analytical review and audit work to DeepSeek V4 Pro. Use when the user wants a code review, architecture audit, security analysis, TDD check, maintainability assessment, deep-module audit, or heavy read/analysis. Also use for checking provider health (doctor), diagnosing failures (diagnose), viewing pricing (pricing), or checking cumulative spend (cost). Invoke via /ocask or when the task requires deep analytical scrutiny.
user-invocable: true
---

# ocask v0.1 — OpenCode Analytical Scrutiny Kit

## Rule

One canonical ocask binary: `ocask` on PATH, or `/home/soultransit/devtony/opencode-verify/ocask.mjs`,
or `node ~/ocask/ocask.mjs`. Do not inline `opencode run` commands;
use `ocask` for all DeepSeek/hy3 analytical delegation.

The host (Claude) owns scope, prompt, evidence collection, and verdict interpretation.
ocask owns the analytical review — it inspects code, traces paths, and delivers
a structured verdict with cited rationale.

## Routing

| Task | Model | Lens | Flags |
|------|-------|------|-------|
| Code review (diff) | `deepseek-v4-pro` | `code-review` | `--require-verdict` |
| Architecture audit | `deepseek-v4-pro` | `architecture` | `--require-verdict` |
| Security review | `deepseek-v4-pro` | `security` | `--require-verdict` |
| TDD compliance | `deepseek-v4-pro` | `tdd` | `--require-verdict` |
| Maintainability / code quality | `deepseek-v4-pro` | `maintainability` | `--require-verdict` |
| Deep-module audit | `deepseek-v4-pro` | `deep-modules` | `--require-verdict` |
| Heavy read/analysis | `deepseek-v4-pro` | `general` | — |
| Light/fast analysis | `deepseek-v4-flash` | `general` | — |
| Quick sanity check | `hy3` | `general` | — |
| Mandatory gate review | `deepseek-v4-pro` | (any lens) | `--require-verdict --no-fallback` |

DeepSeek v4 Pro is the primary analytical engine. v4 Flash for lighter tasks.
Tencent hy3 is the opposite-family fallback: it is served only over the OpenCode CLI
route `openrouter/tencent/hy3`, using OpenCode's own OpenRouter credential. It is not
served by `ocverify.mjs` and has no native ocask API provider.

## Invocation

### Standard: pipe a diff or pass a task file

```bash
git diff <base>...HEAD | ocask --model deepseek-v4-pro --task - \
  --require-verdict --lens code-review
```

### With context file

```bash
ocask --model deepseek-v4-pro \
  --task ./changes.patch \
  --context ./design-notes.md \
  --require-verdict --lens architecture
```

### Gated (exact model, no fallback)

```bash
ocask --model deepseek-v4-pro \
  --task ./diff.patch \
  --require-verdict --lens security --no-fallback
```

### STDIN prompt (host collects evidence first)

The host should gather the relevant diff, file contents, and context before
invoking ocask. Write everything to a temp file and pass it as `--task`:

```bash
{
  echo "# Objective"
  echo "Review the following changes for correctness and edge cases."
  echo ""
  echo "# Diff"
  git diff main...HEAD
  echo ""
  echo "# Key files"
  for f in src/auth/login.ts src/auth/session.ts; do
    echo "## $f"
    cat "$f"
  done
} > /tmp/ocask-review.md

ocask --model deepseek-v4-pro --task /tmp/ocask-review.md \
  --require-verdict --lens code-review
```

## Evidence Collection

Before invoking ocask, the host MUST:
1. Identify the right comparison base (`git merge-base`, branch point, etc.)
2. Collect the diff
3. Identify key files for context
4. Assemble into a single task file or pipe

The host must NOT ask ocask to guess the diff base or discover relevant files
from scratch. ocask will inspect files it deems necessary, but the starting
point must be supplied.

## Interpreting Verdicts

| Verdict | Host action |
|---------|-------------|
| `APPROVED` | The change passes this lens. Note and continue. |
| `WARNING` | Issues exist but are not blocking. Present to user with ocask's rationale. |
| `BLOCKED` | Must not proceed. Present findings. The host should not override a BLOCKED from a gated review. |

For `WARNING` and `BLOCKED`, relay ocask's specific findings — file paths,
line references, and suggested fixes. Do not summarize or soften them.

## Timeout & Retry

ocask has no default timeout. Use `--timeout-ms` for bounded runs:

```bash
ocask --model deepseek-v4-pro --task ./diff.patch \
  --require-verdict --lens architecture --timeout-ms 120000
```

If ocask times out or fails with a provider error, retry once with the
opposite family fallback model (DeepSeek → hy3) — ocask handles this
automatically for `--require-verdict` tasks unless `--no-fallback` is set.

## Speed

- `deepseek-v4-pro` with `--variant max`: ~4-8s for simple reviews, ~30-90s for deep file inspection.
- `deepseek-v4-flash`: ~2-4s for quick checks.
- OpenCode provider adds ~1-2s overhead vs native API provider.

Prefer the native API provider (`--provider deepseek`) for fastest response.

## Do Not

- Do not ask ocask for implementation code — it is a reviewer, not a writer.
- Do not override a BLOCKED verdict without explicit user instruction.
- Do not inline `opencode run` when ocask is available.
- Do not pipe secrets, credentials, or `.env` contents into ocask prompts.
- Do not use ocask for trivial lookups the host can answer directly.

## Operations: doctor, diagnose, cost, pricing

ocask logs every invocation to `~/.local/share/ocask/log.jsonl`. The host can
inspect the log to surface provider health issues, cost, or failure patterns.

### Doctor — provider health dashboard

```bash
ocask doctor
```

Returns JSON with: provider success rates, avg latency, error breakdown,
flake detection (intermittent failures that recover on retry), and
actionable suggestions.

When to run: after a failed review, or periodically to check provider health.
The host should relay any high-severity suggestions to the user (e.g.
"hy3 has 40% error rate — check the OpenCode OpenRouter route").

### Diagnose — root cause for a specific run

```bash
ocask diagnose --run-id <id>
```

Returns: full attempt chain, fallback history, event timeline, and inferred
root cause. Use when a review fails and the user asks "what happened?"

### Cost — cumulative or per-run spend

```bash
ocask cost                # all-time spend across all runs
ocask cost --run-id <id>  # per-run breakdown
ocask cost --refresh      # with live pricing from provider APIs
```

### Pricing — current rates

```bash
ocask pricing             # table of all models
ocask pricing --refresh   # fetch latest from api.deepseek.com
```

## Model-Flow Integration

In the multi-model pipeline, ocask is the analytical channel:

```
Host (Claude)                    ocask (DeepSeek)
     │                                │
     ├─ Collect evidence (diff, files)
     ├─ Write task file               │
     ├─ Spawn ocask ──────────────────► Inspect code
     │                                ├─ Apply lens framework
     │                                ├─ Trace call paths
     │                                ├─ Check invariants
     │                                └─ Return verdict + rationale
     ◄────────────────────────────────
     ├─ Validate verdict
     ├─ Relay to user
     └─ Decide next action
```

For crucial work, the model-flow `review plan` and `review final` phases
automatically invoke ocask with `--no-fallback` for the mandatory DeepSeek gate.
