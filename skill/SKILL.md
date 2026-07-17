---
name: ocask
description: Delegate analytical review and audit work to DeepSeek V4 Pro. Use when the user wants a code review, architecture audit, security analysis, TDD check, or maintainability assessment. Also use for heavy read/analysis work. Invoke via /ocask or when the task requires deep analytical scrutiny.
user-invocable: true
---

# ocask — OpenCode Analytical Scrutiny Kit

## Rule

One canonical ocask binary: `/home/soultransit/devtony/opencode-verify/ocask.mjs`
(or the installed `ocask` on PATH). Do not inline `opencode run` commands;
use `ocask` for all DeepSeek/Qwen analytical delegation.

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
| Quick sanity check | `qwen3.7-plus` | `general` | — |
| Mandatory gate review | `deepseek-v4-pro` | (any lens) | `--require-verdict --no-fallback` |

DeepSeek v4 Pro is the primary analytical engine. v4 Flash for lighter tasks.
Qwen 3.7 Plus is the fallback: it handles opposite-family retries automatically on
malformed DeepSeek output, and can be used explicitly for quick one-off checks.

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
opposite family fallback model (DeepSeek → Qwen) — ocask handles this
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
