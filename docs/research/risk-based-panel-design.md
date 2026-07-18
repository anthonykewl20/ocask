# Risk-Based Panel Selection — Design (Deferred #23 Follow-Up)

**Status:** architecture decision (NO source edits)
**Date:** 2026-07-18
**Based on:** salvage `.evidence/salvage-verify-panel.mjs`, landed #23 consensus panel
(`resolvePanelMembers`, `computeConsensus`, `runPanel`, `logPanelResult`), current
`ocask.mjs` + `logging.mjs` in this worktree.

---

## Context

The consensus panel (`--panel`, cross-family K=2) landed in #23. Every panel invocation
uses the same fixed cross-family pair: the caller's `--model` + its cross-family counterpart
(default `deepseek-v4-pro` ↔ `qwen3.7-max`). This is correct for a first ship, but it
treats every change identically. A one-line typo fix gets the same multi-model panel as a
migration that touches auth, billing, and the schema.

The salvage's `verify-panel.mjs` had `detectRisk` and `selectPanel` that adapt the panel
(which models, N, and K) to the risk of the change under review. This document designs
the equivalent for ocask: **risk-based panel selection** so trivial changes use a lean
review and high-risk changes get the strictest audit.

We ground every decision in:
- The salvage reference (`.evidence/salvage-verify-panel.mjs`): `PANEL_BY_RISK`,
  `detectRisk`, `selectPanel`, `ALLOWED_RISK`, `parseChangedLinesAndFiles`,
  `hasUnifiedHeaders`, `classifyDiffInput`.
- The landed #23 design (`.evidence/issue23-verify-panel-design.md`): consensus
  semantics, abstention rules, the `runPanel` contract, and what was explicitly deferred.
- The current codebase: `ocask.mjs` (`resolvePanelMembers`, `computeConsensus`,
  `runPanel`, `runAsk`), `logging.mjs` (`logPanelResult`, `classifyFailure`, `PANEL_QUORUM_CLASSIFICATION`).
- The provider/factory trust table: only 2 families (deepseek, qwen) are operational
  (`modelFamily` returns `null` for kimi, minimax, mimo — they are in `PAID_MODELS`
  but have no identity-transport entries).

---

## Decision 1 — RISK INPUT

**How is risk DETECTED when ocask's input may be a prompt, not a diff?**

### Rule: `--risk` flag with `auto` diff-detection fallback.

ocask's `--context` (and `--task`) can be anything: a prose description, a file path, a
unified diff, or `/dev/stdin`. The salvage's `detectRisk` only works on unified diffs.
We need a way for the user to declare risk explicitly AND a way for ocask to detect it
when there's a diff.

```js
const ALLOWED_RISK = new Set(['auto', 'trivial', 'default', 'high']);
```

**`--risk` flag** (new):

```
ocask --model deepseek-v4-pro --task "review this PR" --context pr.diff --panel --risk auto
ocask --model deepseek-v4-pro --task "review this PR" --context pr.diff --panel --risk high
```

- `auto` (default): inspect `--context`. If it looks like a unified diff (has `---`
  and `+++` headers, or `diff --git` lines), parse it via `detectRisk` to classify.
  If it doesn't look like a diff, fall back to `default`.
- `trivial` / `default` / `high`: use the declared risk directly. No diff inspection.
- Invalid values → error with usage message.

**`classifyDiffInput`** (adapted from salvage line 210):

```js
export function classifyDiffInput(text) {
  if (!String(text || '').trim()) return 'empty';
  const lines = text.split(/\r?\n/);
  const hasGitHeaders = lines.some(l => l.startsWith('diff --git '));
  const hasUnified = lines.some(l => l.startsWith('--- ')) && lines.some(l => l.startsWith('+++ '));
  if (hasGitHeaders || hasUnified) return 'diff';
  return 'prose';  // not a diff
}
```

**`detectRisk`** (adapted from salvage line 237):

```js
const RISK_BOUNDARY_LINES = 400;
const RISK_BOUNDARY_FILES = 5;
const TRIVIAL_LINES = 15;
const TRIVIAL_FILES = 1;
const RISK_PATH_RE = /(^|\/)(auth|login|secret|crypto|token|password|payment|billing|money|migrat)/i;

export function detectRisk(diffText) {
  const { touchedFiles, changedLines } = parseChangedLinesAndFiles(diffText || '');

  // High-signal paths override line counts.
  if (touchedFiles.some(file => RISK_PATH_RE.test(file))) return 'high';

  // Large diffs are high risk by volume.
  if (changedLines > RISK_BOUNDARY_LINES || touchedFiles.length > RISK_BOUNDARY_FILES) return 'high';

  // Tiny diffs are trivial.
  if (touchedFiles.length === TRIVIAL_FILES && changedLines <= TRIVIAL_LINES) return 'trivial';

  return 'default';
}
```

**`parseChangedLinesAndFiles`** — ported from salvage line 151. Counts touched files
and changed (`+`/`-`) lines from a unified diff, skipping headers.

**Risk resolution flow:**

```
--risk explicit value? ──yes──> use it
      │
      no (auto)
      │
      --context looks like a diff? ──no──> fallback: 'default'
      │
      yes
      │
      detectRisk(diffText) ──> trivial / default / high
```

**Rationale for `auto` → `default` when no diff:**
The absence of a diff doesn't mean low risk — it means the caller is asking about
something without providing a patch file. Defaulting to `default` (cross-family panel)
is the conservative choice. A user reviewing a prose task description might still have
high-risk code changes behind it; we can't know.

---

## Decision 2 — RISK → PANEL MAPPING

**Define PANEL_BY_RISK for ocask's models. Cross-family invariant from #23 preserved.**

### The constraint: only 2 families are operational today.

`modelFamily()` in `providers/factory.mjs:99` recognizes only `deepseek` and `qwen`.
`kimi`, `minimax`, and `mimo` are in `PAID_MODELS` but have no family recognition and
no identity-transport entries. They CANNOT participate in a panel until those gaps are
filled. This is an honest limit, not a design oversight.

### PANEL_BY_RISK for the first deliverable:

```js
const PANEL_BY_RISK = {
  trivial: {
    mode: 'solo',
    // No panel at all. The primary model runs the standard (non-panel) path.
    // A trivial change (≤15 lines, 1 file, no sensitive paths) does not need
    // cross-family verification. This is the salvage's approach: its trivial
    // tier used a single deepseek-v4-flash.
  },
  default: {
    mode: 'panel',
    cross_family: true,
    // N=2: the caller's --model + its cross-family counterpart.
    // K=2: strict-majority — both families must produce judgments.
    // This is the EXISTING panel from #23. No change needed.
  },
  high: {
    mode: 'panel',
    cross_family: true,
    // N=2, K=2 — same size as default because we only have 2 families.
    // (See Decision 4 for the independence discussion.)
    //
    // The "high" tier differs in ENFORCEMENT, not size:
    //   - Mandatory --require-verdict (implied; a high-risk review without
    //     a verdict would be pointless).
    //   - Mandatory --no-fallback (identity-preserving transports only —
    //     no model swaps in a high-stakes review).
    //   - Per-member LENS assignment: one member uses 'security', the other
    //     'code-review' — different lenses catch different classes of defect.
    //     (lens assignment is deferred to a follow-up; first ship uses the
    //      same lens for both members.)
  },
};
```

**How K scales:**

| Risk | N | K | K rule | Cross-family |
|---|---|---|---|---|
| trivial | 1 (solo) | — | single-model, no consensus | no panel |
| default | 2 | 2 | strict-majority (both must judge) | yes |
| high | 2 | 2 | strict-majority (both must judge) | yes |

K does NOT scale with risk today because N cannot scale without more families. When
a third family becomes operational (e.g. kimi gets `modelFamily` support), high can
grow to N=3, K=2 (majority with the BLOCKED tiebreaker, exactly as designed in #23 —
the consensus algorithm doesn't change, only the member count).

**What `selectPanel` returns:**

```js
export function selectPanel(risk, { model, noFallback = false }) {
  const tier = PANEL_BY_RISK[risk];
  if (!tier) throw new Error(`Unsupported risk: ${risk}`);

  if (tier.mode === 'solo') {
    return { mode: 'solo', panel: null, k: null, noFallback };
  }

  // mode === 'panel'
  const counterpart = defaultFallbackModel(model);  // cross-family counterpart
  const members = [model, counterpart].filter(Boolean);

  return {
    mode: 'panel',
    members,       // [model, counterpart]
    k: tier.cross_family ? Math.floor(members.length / 2) + 1 : members.length,
    noFallback: risk === 'high' ? true : noFallback,
    // strict flags for high-risk (enforced by runAsk before dispatching)
    strict: risk === 'high',
  };
}
```

**Why `trivial` bypasses the panel entirely:**
The panel's value is cross-family independence — catching errors that one model family
misses. A 5-line comment fix has near-zero risk of cross-family disagreement. Running
2 models for it wastes tokens and wall-clock time. The salvage made the same choice:
its `PANEL_BY_RISK.trivial` is a single model.

---

## Decision 3 — COMPOSITION WITH #23

**Reuse `resolvePanelMembers`, `computeConsensus`, `runPanel` — `selectPanel` just
picks the member list + K that feed them.**

The #23 architecture is modular. `selectPanel` is a NEW function that runs BEFORE
`runPanel` and decides which models to use. The existing functions are downstream
consumers and do not change:

```
runAsk (ocask.mjs:589)
  │
  ├─ [--risk flag parsed at line 944 area]
  │
  ├─ riskResolution(): decide effective risk
  │     ├─ classifyDiffInput(contextText) → 'diff' | 'prose' | 'empty'
  │     ├─ detectRisk(contextText)         → 'trivial' | 'default' | 'high'
  │     └─ return effective risk
  │
  ├─ selectPanel(effectiveRisk, { model, noFallback })
  │     ├─ mode='solo'  → fall through to standard (non-panel) path
  │     └─ mode='panel' → return { members, k, noFallback, strict }
  │
  └─ runPanel({ model, ...members, k, noFallback, ... })
        │
        ├─ resolvePanelMembers(model, members, ...)   ← UNCHANGED
        ├─ invokeWithFallback per member               ← UNCHANGED
        ├─ computeConsensus({ memberResults, k })      ← UNCHANGED
        ├─ logPanelResult(...)                         ← UNCHANGED
        └─ return panel result envelope                ← UNCHANGED
```

### Abstention/quorum/fail-closed guarantees are untouched.

`computeConsensus` (ocask.mjs:396) already implements Decision 1 and 2 from #23:
- Only judgments (class:`'judgment'` with canonical verdict) count as votes.
- Abstentions are excluded from vote counts.
- If judgments_count < K → `degraded: true`, `consensus_verdict: null` → panel no-judgment.
- BLOCKED tiebreaker: if any member votes BLOCKED and quorum is met but no majority → BLOCKED.

A bigger panel (N=3, K=2) would still require at least 2 real judgments. A single
surviving voice from a 3-member panel is still `degraded` — the quorum is K=2. The
logic is identical regardless of N and K: **abstentions never fake a verdict.**

The hazard the #23 design explicitly guards against — "a panel of N=3 with K=2 where
2 members time out → 1 judgment remaining → panel no-judgment" — applies equally at
N=2 (K=2, 1 timeout → 1 judgment → no-judgment) and N=3 (K=2, 2 timeouts → 1 judgment
→ no-judgment). The guarantee holds at any N.

---

## Decision 4 — INDEPENDENCE AT HIGHER N

**With only 2 families, how do you build N>2 without repeating a family (which would
be fake independence)?**

### Honest answer: you cannot build a fully-independent N>2 panel today.

The independence argument for cross-family panels rests on three layers:

1. **Different model architectures** (deepseek's MoE vs qwen's dense transformer)
2. **Different training corpora** (different web-scale data, different curation)
3. **Different alignment pipelines** (different RLHF, different safety tuning)

Two models from the SAME family (e.g. `deepseek-v4-pro` + `deepseek-v4-flash`) share
layers 1–3 completely. They differ only in:
- **Checkpoint** (different training step, different distillation target)
- **Inference cost/quality tradeoff** (flash is smaller/faster, pro is larger/deeper)

This is PARTIAL independence: a bug in the base architecture's reasoning about a code
pattern would likely affect both checkpoints. But a hallucination from the larger model
might not reproduce on the smaller one (different capacity → different failure modes).

### Our position: N is capped at 2 today. Growing it requires adding operational families.

The honest tiers are:

| Tier | N | Independence | Mechanism |
|---|---|---|---|
| trivial | 1 (solo) | N/A | skip panel |
| default | 2 | full cross-family | deepseek + qwen, K=2 |
| high | 2 | full cross-family | same panel, stricter enforcement |

When a third family becomes operational (kimi, minimax, or mimo — whichever gets
`modelFamily` + identity-transport entries first), high can become N=3, K=2. Until
then, the "high" tier is about enforcement strictness (mandatory no-fallback,
mandatory verdict, potentially per-member lenses) rather than panel breadth.

### What we explicitly reject: fake independence.

Adding `deepseek-v4-flash` alongside `deepseek-v4-pro` in a panel and calling it
"independent" would be dishonest. Two checkpoints of the same architecture are
correlated — their errors overlap more than cross-family errors. The salvage ran
models from 4+ families (deepseek, qwen, kimi, minimax, mimo) — it had enough
diversity to build N=5 with real independence. ocask does not today.

### Path to N>2:
1. Add `modelFamily` recognition for kimi models (they're already in `PAID_MODELS`).
2. Add identity-transport entries for kimi models in the trust table.
3. Add a kimi provider module (transport to kimi's API).
4. Then `PANEL_BY_RISK.high` grows to N=3, K=2.

This is a well-scoped follow-up, not a redesign of the panel machinery.

---

## Decision 5 — SCOPE + ACCEPTANCE

### First shippable deliverable: `--risk` flag + `detectRisk`/`selectPanel` + diff-based auto-detection.

**What ships:**
1. New CLI flag: `--risk auto|trivial|default|high` (default `auto`).
2. `classifyDiffInput(contextText)` — detects whether `--context` is a unified diff.
3. `detectRisk(diffText)` — classifies a diff into trivial/default/high.
4. `selectPanel(risk, { model, noFallback })` — returns `{ mode, members, k, strict }`.
5. Integration into `runAsk`: call `selectPanel` before dispatching to `runPanel` or
   the standard path.

**What is explicitly deferred (follow-up issues):**
| Feature | Reason |
|---|---|
| Per-member lens assignment (high risk: security + code-review) | Requires lens propagation through panel member config — `runPanel` currently applies a single lens to all members |
| N>2 panels (kimi/minimax/mimo as third family) | Requires `modelFamily` + identity-transport entries + provider module for those families |
| `buildEvidenceBundle` (repo-aware context assembly) | Salvage's evidence bundler is substantial standalone work; not needed for risk detection (which only needs diff parsing) |
| Soft-flag deduplication (`dedupeSoftFlags`, K=2 consensus on flags) | Requires soft_flags from individual verifiers (ocverify must produce them first) |
| Hard-repro emission (repro test body, `--emit-tests`) | Requires hard repro in verifier output (ocverify must produce them first) |
| `lens` propagation per panel member | `runPanel` builds one prompt with one lens; splitting per member requires prompt-per-member |

### Acceptance criteria (user-level e2e — real CLI, rc/stdout/stderr; silent rc=0 is a failure):

1. **`--risk` flag accepted:**
   ```
   ocask --model deepseek-v4-pro --task "review" --panel --risk high --json
   ```
   - Valid values (`auto`, `trivial`, `default`, `high`) accepted.
   - Invalid value → error message to stderr, non-zero exit, descriptive output.

2. **`--risk trivial` bypasses panel:**
   ```
   ocask --model deepseek-v4-pro --task "verify: 1+1=2" --require-verdict --panel --risk trivial --json
   ```
   - Runs standard (non-panel) path — single model invocation.
   - `--json` output has no `consensus` or `members` field.
   - Panel log event (`panel.result`) is NOT emitted.
   - Exit 0 for APPROVED, exit 20 for BLOCKED, exit 30 for failure.

3. **`--risk default` or `--risk high` uses panel (identical to current `--panel`):**
   ```
   ocask --model deepseek-v4-pro --task "review code" --require-verdict --panel --risk default --json
   ```
   - Runs cross-family panel (deepseek + qwen), K=2.
   - `--json` output includes `consensus` and `members`.
   - `panel.result` log event is emitted.
   - Same behavior as `--panel` without `--risk` (which defaults to `auto` → `default` when no diff).

4. **`--risk auto` with diff context detects risk:**
   ```
   # Trivial diff (≤15 lines, 1 file)
   ocask --model deepseek-v4-pro --task "review" --context trivial.diff --require-verdict --panel --risk auto --json
   ```
   - Diff parsed, risk detected as `trivial` → solo mode (standard path).
   - Exit 0, JSON has no consensus field.
   ```
   # High-risk diff (>400 lines or sensitive path)
   ocask --model deepseek-v4-pro --task "review" --context big.diff --require-verdict --panel --risk auto --json
   ```
   - Diff parsed, risk detected as `high` → panel mode with strict enforcement.
   - `--json` output includes `consensus` and `members`.
   - Panel runs (deepseek + qwen).

5. **`--risk auto` with non-diff context falls back to `default`:**
   ```
   ocask --model deepseek-v4-pro --task "review this module" --context "The auth module has a bug in login" --require-verdict --panel --risk auto --json
   ```
   - Context is prose, not a diff → risk = `default` → panel mode.
   - `--json` output includes `consensus` and `members`.

6. **`--risk auto` with no context falls back to `default`:**
   ```
   ocask --model deepseek-v4-pro --task "review code" --require-verdict --panel --risk auto --json
   ```
   - No `--context` → risk = `default` → panel mode.

7. **`--risk high` enforces strict mode:**
   ```
   ocask --model deepseek-v4-pro --task "review" --panel --risk high --json
   ```
   - `noFallback` forced to `true` (identity-preserving transports only).
   - If no identity-preserving transport is available for a member → abstention with
     `NO_PROVIDER` mechanism.
   - (Note: `requireVerdict` is already set by the caller's `--require-verdict` flag;
     `--risk high` does not override it but `--panel` without `--require-verdict` on
     high risk is a defensible CLI choice — the first deliverable does not force
     `--require-verdict` for high. That enforcement can be a follow-up.)

8. **Regression: existing `--panel` without `--risk` still works:**
   ```
   ocask --model deepseek-v4-pro --task "review" --require-verdict --panel --json
   ```
   - Defaults to `--risk auto` → `default` (no diff context) → panel mode.
   - Identical behavior to current #23 implementation.
   - All existing #23 acceptance tests pass unchanged.

9. **Silent rc=0 with 0 bytes is a failure** (per map standing preference):
   Every test checks stdout + stderr bytes > 0 AND exit code is correct.

### Code plan:

#### Functions to ADD (new file or in `ocask.mjs`):

**1. `classifyDiffInput(text)`** — after `parseArgs` (~line 107 area) or as a separate
section near `detectRisk`. Ported from salvage line 210.

**2. `detectRisk(diffText)`** — near `classifyDiffInput`. Ported from salvage line 237.
Depends on `parseChangedLinesAndFiles` (ported from salvage line 151).

**3. `parseChangedLinesAndFiles(diffText)`** — near `detectRisk`. Ported from salvage
line 151. Returns `{ touchedFiles: string[], changedLines: number }`.

**4. `selectPanel(risk, { model, noFallback })`** — returns `{ mode, members, k,
noFallback, strict }`. Called before dispatching to `runPanel`.

**5. `resolveRisk({ riskFlag, contextText, noFallback })`** — coordinator. Takes the
`--risk` flag value and `--context` text. Returns the effective risk tier.

```js
export function resolveRisk({ risk = 'auto', contextText = '' }) {
  if (!ALLOWED_RISK.has(risk)) {
    throw new Error(`Unsupported risk: ${risk}. Supported: ${[...ALLOWED_RISK].join(', ')}`);
  }
  if (risk !== 'auto') return risk;

  const diffKind = classifyDiffInput(contextText);
  if (diffKind === 'diff') return detectRisk(contextText);
  return 'default';
}
```

#### Functions to MODIFY in `ocask.mjs`:

**6. `runAsk`** (~line 589):
- Before the `if (panel)` block (line 625), insert risk resolution:
  ```js
  if (panel) {
    const effectiveRisk = resolveRisk({ risk: args.risk, contextText });
    const selection = selectPanel(effectiveRisk, { model, noFallback });
    if (selection.mode === 'solo') {
      // bypass panel — fall through to standard path
      panel = false;  // or use a different control flow
    } else {
      // pass selection.members, selection.k, selection.noFallback to runPanel
    }
  }
  ```
- `runPanel` needs a new parameter for the member list (currently it calls
  `resolvePanelMembers` internally). The seam: either pass `members` + `k` to
  `runPanel`, or have `selectPanel` modify the arguments before `runPanel` sees them.

  **Recommended approach:** Add optional `members` and `k` parameters to `runPanel`.
  When provided, they override the default `resolvePanelMembers` call inside
  `runPanel`. When absent, the existing `resolvePanelMembers({ model, ... })` runs
  as before. This keeps the default `--panel` path identical.

  ```js
  export async function runPanel({
    model, taskText, ..., absoluteDeadlineMs, run_id,
    members: overrideMembers = null,   // NEW: override panel members
    k: overrideK = null,               // NEW: override quorum K
  }) {
    const members = overrideMembers || resolvePanelMembers({ model, ... });
    const k = overrideK || Math.floor(members.length / 2) + 1;
    // ... rest unchanged
  }
  ```

**7. `parseArgs`** (~line 94):
- Add `'risk'` to `VALUE_ARGS`.

**8. `runMain`** (~line 918):
- Parse `--risk` from args. Validate against `ALLOWED_RISK`.
- Pass `risk` through to `runAsk`.
- `runAsk` passes `risk` to `runPanel` or `selectPanel`.

#### NO changes to:
- `logging.mjs` — `logPanelResult` already handles the panel result contract.
- `resolvePanelMembers` — `selectPanel` produces the member list that CAN feed it,
  or `runPanel` can use `selectPanel`'s output directly.
- `computeConsensus` — agnostic to risk tier; it works for any N and K.
- `classifyFailure`, `describeOutcome`, `exitCodeForOutcome`, `buildJsonResponse` —
  the four-way caller contract is agnostic to risk.
- `providers/` — no new models introduced.
- `system.mjs`, `pricing.mjs`, `version.mjs` — unrelated.

### Seams for `runPanel` override:

The current `runPanel` (ocask.mjs:459) resolves members internally at line 472:
```js
const members = resolvePanelMembers({ model, noFallback, preferredProvider: provider, env });
```

Add an optional `members` parameter to bypass this:
```js
const members = overrideMembers ?? resolvePanelMembers({ model, noFallback, preferredProvider: provider, env });
```

This is the minimal change — one line in `runPanel`, plus the `selectPanel` call in
`runAsk`. All other panel machinery is downstream and unchanged.

---

## Summary

| Decision | Answer |
|---|---|
| 1. Risk input | `--risk auto\|trivial\|default\|high` (default `auto`). `auto` inspects `--context` for diff-like content; if diff → `detectRisk`; if not → fallback `default` |
| 2. Risk → panel mapping | trivial → solo (no panel). default → N=2, K=2 cross-family. high → N=2, K=2 cross-family with strict enforcement (no-fallback). K does not scale until we have >2 families |
| 3. Composition with #23 | `selectPanel` (new) picks members + K → feeds into existing `runPanel`/`computeConsensus`. Abstention/quorum/fail-closed guarantees are untouched |
| 4. Independence at higher N | N is capped at 2 today — only deepseek and qwen are operational. Adding same-family models (e.g. deepseek-v4-flash + deepseek-v4-pro) is partial independence, not full. Growing N requires adding operational families (kimi is the next candidate) |
| 5. Scope | First deliverable: `--risk` flag, `detectRisk`, `selectPanel`, diff-based auto-detection. Acceptance = user-level e2e with real CLI output. Per-member lenses, N>2, and evidence bundles are deferred |

### File:line seam summary:

| What | Where | Change |
|---|---|---|
| `parseArgs` | ocask.mjs:94 | Add `'risk'` to `VALUE_ARGS` |
| `classifyDiffInput` | ocask.mjs (new, ~after line 107) | New function |
| `parseChangedLinesAndFiles` | ocask.mjs (new, ~after line 107) | New function |
| `detectRisk` | ocask.mjs (new, ~after line 107) | New function |
| `resolveRisk` | ocask.mjs (new, ~after line 107) | New function |
| `selectPanel` | ocask.mjs (new, ~after line 130) | New function |
| `runPanel` signature | ocask.mjs:459 | Add optional `members`, `k` params |
| `runPanel` resolve | ocask.mjs:472 | Use `overrideMembers ?? resolvePanelMembers(...)` |
| `runAsk` dispatch | ocask.mjs:625 | Call `resolveRisk` → `selectPanel` → dispatch to `runPanel` or fallthrough |
| `runMain` parse | ocask.mjs:944 | Validate `--risk`, pass through |
| `runMain` call | ocask.mjs:965 | Pass `risk` to `runAsk` |
