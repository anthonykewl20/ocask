# ocask

A headless CLI delegation tool that sends review, audit, and analysis tasks to
paid OpenCode Go models (DeepSeek / Qwen) through the installed OpenCode CLI.
Designed as the analytical brain for multi-model orchestration pipelines.

## What it does

`ocask` wraps `opencode run` with a structured prompt layer that maximizes
DeepSeek v4 Pro's analytical reasoning strength:

- **Chain-of-thought execution guidance** — "Think step by step, inspect
  evidence deeply, cite specific code patterns."
- **7 review lenses** — each a structured audit framework distilled from
  production engineering skills:
  - `code-review` — Fowler's 12 code smells + correctness/completeness
  - `architecture` — deep vs shallow modules, seams, deletion test,
    coupling/cohesion
  - `security` — injection surfaces, auth, data exposure, supply chain
  - `tdd` — test-contract alignment, tautological/implementation-coupled/
    horizontal-slicing anti-patterns
  - `maintainability` — thermo-nuclear audit: code judo, 1K-line boundary,
    spaghetti detection, approval bar
  - `deep-modules` — interface audit, seam placement, shallow module detection,
    adapter discipline
  - `general` — unstructured analytical review (default)
- **Verdict contracts** — `APPROVED | WARNING | BLOCKED` with structured
  rationale
- **Exact-model gates** — `--no-fallback` pins the primary model for
  mandatory review gates
- **Privacy-safe metadata** — attempt timing, model routing, verdict without
  raw prompt/output/credentials

## Install

### Prerequisites

- **OpenCode CLI** installed and authenticated (`opencode` on PATH)
- **Node.js ≥ 20**

```bash
# Clone
git clone https://github.com/anthonykewl20/ocask.git
cd ocask

# Make the runner executable
chmod +x ocask.mjs

# Optional: symlink to PATH
ln -s "$(pwd)/ocask.mjs" ~/.local/bin/ocask
```

Verify:

```bash
ocask --model deepseek-v4-pro --task "Reply: VERDICT: APPROVED. Test." --require-verdict
```

## Usage

```
ocask --model <id> --task <path|-|string>
      [--context <path|-|string>]
      [--lens code-review|architecture|security|tdd|maintainability|deep-modules|general]
      [--require-verdict]
      [--no-fallback]
      [--json]
      [--metadata <path>]
      [--timeout-ms N]
      [--max-tokens N]
```

### Quick examples

```bash
# Basic code review with verdict
git diff main | ocask --model deepseek-v4-pro --task - --require-verdict --lens code-review

# Architecture audit from a diff file
ocask --model deepseek-v4-pro \
  --task ./design-diff.patch \
  --context ./architecture-notes.md \
  --require-verdict --lens architecture

# Thermo-nuclear maintainability audit
ocask --model deepseek-v4-pro \
  --task ./feature-branch.diff \
  --require-verdict --lens maintainability

# TDD compliance check
ocask --model deepseek-v4-pro \
  --task ./tests.diff \
  --require-verdict --lens tdd

# Quick Q&A (no verdict, no lens)
ocask --model deepseek-v4-pro \
  --task "Explain the module structure of src/auth/" \
  --context ./src/auth/

# JSON output with verdict
ocask --model deepseek-v4-pro \
  --task ./diff.patch \
  --json --require-verdict --lens security
```

### Model IDs

Short-form model IDs, no provider prefix:

| Model | ID |
|-------|----|
| DeepSeek v4 Pro | `deepseek-v4-pro` |
| DeepSeek v4 Flash | `deepseek-v4-flash` |
| Qwen 3.7 Plus | `qwen3.7-plus` |
| Qwen 3.7 Max | `qwen3.7-max` |
| Qwen 3.6 Plus | `qwen3.6-plus` |

`ocask` routes DeepSeek models through the `deepseek/` provider and Qwen
models through `opencode-go/`, adding `--pure --variant max` for DeepSeek.

### Fallback

By default, review tasks (`--require-verdict`) fall back to the opposite
model family on malformed output (DeepSeek → Qwen, Qwen → DeepSeek).
Use `--no-fallback` to pin the exact model for mandatory gates.

## How it works

```
ocask (Node.js)
  │
  ├─ buildPrompt()           — assembles the structured prompt with lens framework
  ├─ runAsk()                — validates model, handles fallback
  │   └─ callOpenCode()
  │       └─ opencode run --pure --model deepseek/deepseek-v4-pro --variant max
  │                          — direct one-shot mode, stdin prompt
  └─ validateAssistantOutput() — enforces verdict contract, JSON contract
```

- **Direct mode by default** (no persistent server). Re-enable with
  `OCASK_DISABLE_SERVER=0`.
- **Prompt on stdin**, `--auto` permissions, allow-all config.
- **`--pure`** skips external plugins for reliable headless execution.

## Tests

```bash
node --test ocask.test.mjs
```

53 unit tests covering args parsing, prompt construction, lens frameworks,
model validation, JSONL parsing, output validation, fallback logic, and
env/process management.

## License

MIT
