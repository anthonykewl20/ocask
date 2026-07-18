# Issue #23 — Multi-Model Consensus Verify-Panel Design

**Status:** architecture decision (NO source edits)
**Date:** 2026-07-18
**Based on:** salvage `.evidence/salvage-verify-panel.mjs`, current `main` with #8/#9/#10/#12 landed

---

## Context

ocask is model-flow's mandatory audit gate. The existing `--cross-verify` (ocask.mjs:496–573)
is a single-buddy check: the primary model produces a verdict, one cross-family buddy reviews
it, and agreement/disagreement is noted. This is a 1-of-1 confirm — not a true consensus panel.

The salvage's `verify-panel.mjs` ran N models in parallel with risk-based panel selection,
K=2 consensus on soft-flags, hard-repro gating, and degraded-panel escalation. It was built
as a standalone tool with its own CLI, evidence bundling, and per-member retry/failover. We do
NOT port it wholesale; we study its MODEL and adapt the consensus concepts to ocask's
existing architecture (absolute deadline, identity-trust table, classifyFailure taxonomy,
four-way caller contract).

The destination: **a verdict you can trust.** A panel member that could not form a judgment
(infra failure, timeout, auth) must never be mistaken for a voice of dissent.

---

## Decision 1 — CONSENSUS SEMANTICS

**What is a panel verdict, and how is it computed from N member verdicts?**

### Rule: majority K-of-N with a conservative BLOCKED tiebreaker.

- **K = `Math.ceil(N / 2)` by default**, overridable via `--k N`. An explicit `--k 1` is
  disallowed (a single-model panel is not a panel — use the regular path).
- **Verdict space:** APPROVED, WARNING, BLOCKED (the same three verdicts the existing code
  already produces and validates). A panel member may also produce no verdict (abstention —
  see Decision 2).
- **Consensus algorithm:**

  1. Collect verdicts from all members that produced a JUDGMENT (class:`'judgment'` from
     `classifyFailure`, i.e. a positively-produced APPROVED/WARNING/BLOCKED).
  2. If fewer than K members produced judgments → **panel returns no-judgment** (see Decision 2).
  3. Count the votes:
     - If a majority (≥K) of the judgments agree on the same verdict → **that is the consensus verdict.**
     - **BLOCKED tiebreaker:** if any member votes BLOCKED and at least K members voted (even
       if they disagree), and no single verdict has a majority → **the consensus verdict is BLOCKED.**
       Reasoning: for an audit gate, a single credible BLOCKED with quorum met is enough to
       gate. "Better to investigate a false positive than ship a defect."
     - If no BLOCKED, verdicts are split between APPROVED and WARNING → **WARNING** (the
       more conservative of the two non-gating verdicts).

  **Example (N=3, K=2):**
  | Votes | Consensus |
  |---|---|
  | APPROVED, APPROVED, APPROVED | APPROVED |
  | BLOCKED, BLOCKED, APPROVED | BLOCKED (majority) |
  | BLOCKED, APPROVED, WARNING | BLOCKED (tiebreaker — one BLOCKED + quorum met) |
  | BLOCKED, APPROVED, ABSTAIN | BLOCKED (majority of judgments: 2/2 BLOCKED… wait no, it's 1 BLOCKED + 1 APPROVED, both count. K=2, quorum met, split. BLOCKED tiebreaker applies.) |
  | APPROVED, WARNING, ABSTAIN | WARNING (split, no BLOCKED, WARNING is more conservative) |
  | APPROVED, ABSTAIN, ABSTAIN | no-judgment (only 1 judgment < K=2) |

### Why not unanimous?
Unanimity would make the panel fragile: any single dissenter blocks consensus, which means the
panel essentially returns WARNING on every non-trivial review. A majority with a conservative
BLOCKED backstop produces actionable outcomes: ship (APPROVED), warn (WARNING), or block
(BLOCKED) — with genuine signal rather than noise.

### Why not any-BLOCKED-blocks?
A lone BLOCKED from a model that is frequently over-cautious would make the panel useless. The
BLOCKED tiebreaker activates only when quorum IS met (enough models judged) but no single
verdict has a majority. A single BLOCKED + (K-1) APPROVED among K judgments → BLOCKED (the
majority didn't agree, the tiebreaker gives BLOCKED the benefit of the doubt). A single
BLOCKED + (N-K) abstentions where K>1 is NOT met → the panel returns no-judgment, NOT BLOCKED
— the lone voice is unverified.

---

## Decision 2 — NO-JUDGMENT ≠ DISSENT (abstentions)

**The map's core theme, via #10.**

Every panel member's result is classified via `classifyFailure` (logging.mjs:172). A member
that returns `class:'no-judgment'` has NOT voted against the code. It ABSTAINED. The cause
could be:
- Timeout (`reply-absent/their-side`, censored)
- Auth failure (`reply-absent/our-side`)
- Provider error, connection error, rate limit, etc.
- Malformed model output (`reply-unusable`)

### Abstention rules:

1. **Abstentions are excluded from vote counts.** Only judgments (class:`'judgment'`) are
   tallied.
2. **Minimum real judgments = K.** The quorum threshold K is defined in terms of REAL
   JUDGMENTS. Regardless of panel size N, the panel needs at least K members to have
   demonstrably judged the code. If fewer than K judgments are available:
   - The panel returns **no-judgment** (exit 30).
   - The report includes the count of judgments, the count of abstentions, and the reason
     each member abstained.
   - This is NEVER a false agreement, NEVER a false BLOCKED, NEVER a false WARNING.
   - A panel of N=3 with K=2 where 2 members time out → 1 judgment remaining → panel
     no-judgment. The 1 surviving judgment is recorded but NOT acted on.
3. **Abstention reasons are surfaced** in the panel output so a human or Opus can adjudicate.
4. **Degraded panel detection** (from salvage): the report includes `judgments_count` and
   `abstentions_count` and a `degraded` boolean when `judgments_count < K`.

### What this prevents:
The current `--cross-verify` has a blind spot: if the buddy times out, the buddy failure is
silently logged and the primary verdict stands. This is a correct design for a 1-buddy
"confirm" mode but it's insufficient for a consensus panel: a panel with 3 members where 2
time out must NOT produce a verdict based on the 1 surviving member. That would be a
single-model verdict dressed as a panel — the same trust model as no panel at all.

---

## Decision 3 — PANEL SELECTION under #12 identity

### The panel must be cross-FAMILY. A panel of "the same weights twice" is not independent.

The #12 identity-trust table (providers/factory.mjs:44–85) declares which transports serve
which model weights. The key constraint:

- **Each panel member is a (model, transport) pair.** The panel selects models from
  DIFFERENT families (deepseek vs qwen). This is the minimum viable independence: two
  different weight sets, two different training corpora, two different alignment pipelines.
- **Same-weights detection:** Before running, the panel validator checks that no two members
  resolve to the same model family. If a user (or automatic selection) tries to assemble a
  panel of `deepseek-v4-pro` on `opencode` and `deepseek-v4-pro` on `deepseek` — that's the
  same weights twice, rejected with an error. The #12 trust table is the authority on "are
  these the same weights?" (model name is primary; transport is secondary).
- **Default panel (first shippable):** Fixed cross-family:
  ```
  [ { model: 'deepseek-v4-pro', transport: auto },   // resolves via resolveProviderChain
    { model: 'qwen3.7-max',   transport: auto } ]   // cross-family
  ```
  This is N=2, K=2 (both must produce judgments; 1 abstention → panel no-judgment).
- **Risk-based panel selection (DEFERRED).** The salvage's `detectRisk`/`selectPanel` adds
  trivial (1-model) and high (5-model) tiers. This requires evidence-bundle building, diff
  parsing, and repo-aware context assembly — all of which are substantial features in their
  own right. Ship the fixed cross-family panel first; risk auto-detection is a follow-up
  issue.

### Transport selection per member:

Each panel member's transport is resolved through `resolveProviderChain` (factory.mjs:163)
with the same `--provider`/`--no-fallback` controls that the primary model gets. This means:
- If the user specifies `--provider deepseek`, ALL panel members route through that provider
  (if supported), or through identity-preserving transports.
- If `--no-fallback` is set, each member's transport must be identity-preserving per the
  trust table.
- A member whose resolved transport chain is empty (no provider can serve that model) is
  recorded as an abstention with reason `NO_PROVIDER`.

---

## Decision 4 — ABSOLUTE DEADLINE (#8)

### One caller-owned deadline. All members share it.

The existing `runAsk` already computes `absoluteDeadlineMs` at line 372 and exposes
`nextAttemptTimeoutMs()` which returns `remainingBudget(absoluteDeadlineMs, Date.now())`.

### Panel integration:

1. **The panel inherits the SAME `absoluteDeadlineMs`** that the primary model uses.
   If the user called with `--timeout-ms 120000`, the panel does NOT get its own fresh 120s
   — it runs inside what remains after the primary's own invocation.

2. **Wait — there's a sequencing question.** Currently, `--cross-verify` runs the buddy
   AFTER the primary produces its verdict (ocask.mjs:497–572). A true panel runs members in
   PARALLEL, not sequentially. The primary model becomes just one panel member.

   **Sequencing model:** The panel mode is an alternative to the primary+fallback+buddy
   flow. When `--panel` is requested:
   - The primary model is NOT run separately first.
   - All panel members (including the would-be-primary) are launched in parallel via
     `Promise.all` (or `Promise.allSettled` for proper abort handling).
   - The caller's `absoluteDeadlineMs` is computed once. Each member receives
     `nextAttemptTimeoutMs()` at launch time, which is the remaining budget at that instant.
   - If a member's budget is ≤0 at launch time, it is recorded as an abstention with
     mechanism `TIMEOUT` (the clock expired before it could start).

3. **Parallel vs sequential debate resolved:** The salvage runs members in parallel
   (`Promise.all` at salvage line 966). This is correct — the panel's wall-clock is
   bounded by the slowest member, and parallel execution maximizes the chance that all
   members complete within the absolute deadline. Sequential execution (primary first, then
   panel) would make the timeout math irreducible: each member's budget depends on how
   long the prior members took, and the caller can't reason about it.

4. **A member's timeout → abstention** in the consensus tally (Decision 2). The timeout is
   classified as `no-judgment/reply-absent/their-side` or TIMEOUT mechanism, which is distinct
   from a judgment. The panel does not retry timed-out members (the existing primary+fallback
   retry loop belongs to the primary path, not the panel path — fallback is a transport
   concern, not a member-concern).

### Timing contract:
```
Caller specifies: --timeout-ms 120000 --panel
                 ↓
abs_deadline = now + 120000
                 ↓
All panel members launched in parallel, each with budget = abs_deadline - now
                 ↓
Slowest member wall-clock ≤ 120s
If any member's budget ≤ 0 at launch → immediate abstention
Panel result available ≤ 120s after invocation
```

---

## Decision 5 — OUTPUT / RECORD

### What the panel emits, and how it composes with the existing exit bands and log.

### Panel result envelope (the `result` object from `runAsk` extended):

```js
{
  ok: true,                    // panel ran (may still be no-judgment)
  output: "<human-readable>",  // combined panel text
  // --- Consensus ---
  verdict: "APPROVED" | "WARNING" | "BLOCKED" | null,  // null = no-judgment
  consensus: {                 // NEW: panel-specific
    verdict: "APPROVED" | "WARNING" | "BLOCKED" | null,
    agreement: true | false,       // did all judgments agree?
    judgments_count: 3,            // how many members produced real judgments
    abstentions_count: 0,          // how many members abstained
    degraded: false,               // judgments_count < K
    k: 2,
    n: 3,
  },
  // --- Per-member ---
  members: [                   // NEW
    {
      model: "deepseek-v4-pro",
      transport: "opencode",
      verdict: "APPROVED" | "WARNING" | "BLOCKED" | null,
      classification: { class: "judgment", ... } | { class: "no-judgment", ... },
      output_preview: "...",   // first 200 chars
    },
    ...
  ],
  // --- Soft-flags (DEFERRED) ---
  consensus_soft_flags: [],    // deduplicated at K=2, DEFERRED to follow-up
  // --- Existing fields preserved ---
  metadata: { ... },
  run_id: "...",
  cross_verify: null,          // replaced by panel, kept null for compatibility
}
```

### Exit bands (#7/#11):

| Panel Outcome | `describeOutcome` | exit code |
|---|---|---|
| Consensus APPROVED | `{ outcome: "judgment", verdict: "APPROVED" }` | 0 |
| Consensus WARNING | `{ outcome: "judgment", verdict: "WARNING" }` | 0 |
| Consensus BLOCKED | `{ outcome: "judgment", verdict: "BLOCKED" }` | 20 |
| Panel no-judgment (quorum failure / too many abstentions) | `{ outcome: "no-judgment", verdict: null, reason: "quorum_failure" }` | 30 |

The existing `describeOutcome` (ocask.mjs:621) and `exitCodeForOutcome` (ocask.mjs:606)
already handle these four outcomes. The panel result's `verdict: null` + `failed: false`
produces `outcome: "no-judgment"` only if we explicitly set `failed: true` — the panel
quorum failure should be treated as a failure for exit-code purposes, so it maps through the
existing `describeOutcome` with `failed: true` and a classification that captures the
quorum-failure mechanism.

**New classification for quorum failure:**
A synthetic classification produced by the panel itself (not from `classifyFailure` of any
single member):
```js
{ class: 'no-judgment', subclass: 'indeterminate', locus: null,
  mechanism: 'PANEL_QUORUM_FAILURE', censored: false, http_status: null, retry_after: null }
```

### --json output:

The `buildJsonResponse` (ocask.mjs:642) already includes `outcome`, `verdict`, `reason`,
`locus`, `mechanism`, `exit_code`, `output`. The panel extends this with `consensus` and
`members` fields added to the JSON response object.

### Logging (#3 record):

Each panel member's invocation is logged as an `attempt.result` event (the existing
infrastructure already handles this for each `invokeWithFallback` call). The panel adds a
new `panel.result` log event:
```js
logEvent('panel.result', {
  run_id,
  verdict,          // consensus verdict or null
  k, n,
  judgments_count,
  abstentions_count,
  degraded,
  agreement,
  member_verdicts: [{ model, transport, verdict, mechanism }, ...],
});
```

### mechanism_message (#9):
Each member's `mechanism_message` is scrubbed via `scrubMessage` and logged locally. The panel
summary does NOT include raw mechanism messages — it only includes classifications. The local
log (0700) stores the scrubbed per-member messages.

---

## Decision 6 — SCOPE

### First deliverable (this issue — the consensus core):

1. **`--panel` flag** (new; replaces/extends `--cross-verify`). When set:
   - The primary model is NOT run first; instead, a panel of cross-family models runs in
     parallel.
   - Default panel: `deepseek-v4-pro` + `qwen3.7-max` (N=2, K=2).
   - Consensus computation: majority K-of-N with BLOCKED tiebreaker.
   - Abstention handling: judgments_count < K → panel no-judgment (exit 30).
   - Absolute deadline sharing across all members.
   - Panel result envelope with per-member verdicts and consensus verdict.
   - Composition with existing exit bands (#7/#11).
   - Logging: `panel.result` event.

2. **Acceptance criteria (user-level e2e — real CLI):**
   - `ocask --model deepseek-v4-pro --task "..." --require-verdict --panel`
     → runs deepseek + qwen in parallel, returns consensus verdict.
   - When all members agree APPROVED → exit 0, stdout contains consensus APPROVED.
   - When members disagree (APPROVED vs WARNING) → exit 0, consensus WARNING.
   - When all members time out → exit 30, `outcome: "no-judgment"`, stdout (--json) shows
     `reason: "quorum_failure"`, stderr has `ocask error:` message.
   - When 1 of 2 members times out → exit 30 (K=2, only 1 judgment < K).
   - `--timeout-ms 5000 --panel` with a slow model → panel returns within ~5s (not 5s per
     member), the timed-out member is an abstention.
   - **Silent rc=0 with 0 bytes is a FAILURE** (per map standing preference). The regression
     test must check that stdout + stderr bytes are > 0 and exit code is correct.
   - `--panel --no-fallback` → both members routed through identity-preserving transports.
   - `--panel --provider opencode` → both members routed through opencode (if supported for
     that model; unsupported model → abstention with NO_PROVIDER).

### Explicitly DEFERRED (follow-up issues):

| Feature | Why deferred |
|---|---|
| Risk-based panel selection (`detectRisk`/`selectPanel`) | Requires diff parsing, repo scanning, file-count heuristics — substantial standalone work |
| Evidence bundle building (`buildEvidenceBundle`) | Requires repo-aware context assembly, dependency tracing, grep — not needed for basic panel |
| Soft-flag deduplication (`dedupeSoftFlags`, K=2 consensus on flags) | Requires soft_flags from individual verifiers — ocverify must produce them first |
| Hard-repro emission (`emitReproTestBody`, `writeEmittedTests`, `--emit-tests`) | Requires hard repro in verifier output — ocverify must produce them first |
| Retry/failover per member (the salvage's `FALLBACK_BY_MODEL` and `runWithRetry`) | Transport fallback is already handled by `invokeWithFallback` in factory; model-level retry is a different dimension |
| Custom panel specification (`--panel-model deepseek-v4-pro,qwen3.7-max,kimi-k2.7-code`) | Useful but not essential for first ship; default cross-family is sufficient |
| `--k N` override | Ship with fixed K=ceil(N/2); explicit K override adds complexity for marginal gain |

---

## Code-Change Plan

### Functions to add/modify in `ocask.mjs`:

**1. New function: `resolvePanelMembers`** (~after `guardAllowedModels`, line 114 area)
```js
export function resolvePanelMembers({ model, noFallback, preferredProvider, env }) {
  // Returns: [{ model, family, transport: resolvedProviderChainEntry, ... }]
  // Default panel: the primary model + its cross-family counterpart
  // Validates: at least 2 distinct families, each has at least 1 available transport
}
```

**2. New function: `computeConsensus`** (~after line 620, near `describeOutcome`)
```js
export function computeConsensus({ memberResults, k }) {
  // memberResults: [{ model, verdict, classification }, ...]
  // Returns: { consensus_verdict, agreement, judgments_count, abstentions_count, degraded }
  // Implements Decision 1 (majority + BLOCKED tiebreaker) and Decision 2 (abstention rules)
}
```

**3. New function: `runPanel`** (~after line 576, or refactored from the cross-verify block)
```js
export async function runPanel({
  model, taskText, systemText, contextText, jsonMode, requireVerdict,
  lens, temperature, maxTokens, timeoutMs, provider, noFallback, cwd, env,
  absoluteDeadlineMs,   // THE shared deadline
  run_id,               // THE shared run_id
  invokeWithFallbackFn,
}) {
  // 1. Resolve panel members (decision 3)
  // 2. Build per-member prompts (each gets the same evidence, different instructions)
  // 3. Launch all members in parallel with Promise.allSettled
  //    - Each member gets nextAttemptTimeoutMs(absoluteDeadlineMs)
  //    - Each member's result is classified via classifyFailure
  // 4. Compute consensus (decision 1 + 2)
  // 5. Return panel result envelope
}
```

**4. Modify `runAsk`** (~line 352, the core invocation):
- At entry (line 358 area): if `--panel` is set, skip the primary+fallback+buddy flow
  entirely. Call `runPanel` instead.
- The existing cross-verify block (lines 496–573) is either:
  - (a) Kept as a `--cross-verify` path (1-buddy mode, backward-compatible), OR
  - (b) Redirected to `--panel` with a deprecation notice.
  - **Recommendation:** (a). `--cross-verify` is a simpler contract (primary verdict FIRST,
    then confirm). `--panel` is the new parallel-consensus contract. Both are useful for
    different risk profiles. The cross-verify path already has full test coverage; breaking
    it is unnecessary risk.
- The `runPanel` path shares the same `absoluteDeadlineMs`, `runId`, and `metadata` object
  — it's an ALTERNATIVE to the primary path, not an addition after it.

**5. Modify `describeOutcome`** (~line 621):
- Add `mechanism` parameter handling: when a panel quorum failure occurs, the mechanism
  is `PANEL_QUORUM_FAILURE` and the descriptor's `reason` field reflects it.

**6. Modify `buildJsonResponse`** (~line 642):
- Add `consensus` and `members` fields to the output when a panel was run.

**7. Modify `runMain`** (~line 655):
- Parse new `--panel` flag.
- Pass `panel: true` through to `runAsk`.
- Handle the panel result in the stdout/stderr path (lines 710–718).

### Functions to add/modify in `logging.mjs`:

**8. New log event: `panel.result`** (near line 414, `logVerdict`):
```js
export async function logPanelResult({ runId, verdict, k, n, judgmentsCount,
  abstentionsCount, degraded, agreement, memberVerdicts }) { ... }
```

### Seams in `providers/factory.mjs`:

**9. New export or check: `isCrossFamily`** (near line 99, `modelFamily`):
```js
export function isCrossFamily(modelA, modelB) {
  const fA = modelFamily(modelA);
  const fB = modelFamily(modelB);
  return fA && fB && fA !== fB;
}
```

### No changes to:
- `providers/opencode.mjs`, `deepseek.mjs`, `qwen.mjs` — invokeWithFallback handles
  transport per member transparently.
- `system.mjs`, `pricing.mjs`, `version.mjs` — unrelated.
- `ocverify.mjs` — the verifier contract is unchanged; `runPanel` uses `invokeWithFallback`
  which already invokes the provider correctly.

---

## Open Questions

1. **How many families are enough?** The first ship uses 2 (deepseek + qwen). The map is
   done when a panel of 2 cross-family models produces a verdict you can trust (with the
   rule that 1 surviving voice = no-judgment). Is 2 sufficient, or does the audit gate need
   3+? The salvage used 3 for `default` risk and 5 for `high`. Start with 2 and measure;
   increasing N is additive, not a rewrite.

2. **Should the panel prompt differ per member?** The salvage assigns a different `lens`
   to each member (spec-mismatch, design, code-correctness, cross-file, security). This is
   a powerful pattern — different models see the evidence through different frameworks. For
   the first ship, every panel member gets the same prompt + lens. Lens-per-member is a
   follow-up.

3. **What about the existing `--cross-verify`?** The current buddy check (lines 496–573)
   does the simpler thing: produce a primary verdict, then ask one buddy "do you agree?".
   This has value: it's faster (sequential, not parallel; buddy only runs if primary
   succeeds), and the primary verdict is already available. The panel is a DIFFERENT
   contract: parallel, consensus-based, no primary. Keep both. `--cross-verify` is a
   1-buddy confirm; `--panel` is an N-model consensus. They serve different use cases.

4. **Should the panel use `invokeWithFallback` per member (transport-level retry)?** Yes.
   Each member's invocation goes through the existing `invokeWithFallback` with its own
   transport chain. This means a member can retry on a different transport if the first
   fails — independent of the panel's consensus logic. The member's final result is what
   the factory returns (or throws). A thrown error → classifyFailure → abstention.

5. **Panel + `--no-fallback` interaction.** If `--no-fallback` is set, each member's
   transport chain is restricted to identity-preserving transports (Resolution 5). A
   member with no identity-preserving transport available → immediate abstention. This is
   the correct behavior: the caller asked for no model swaps, and a member whose identity
   cannot be verified should not participate.

6. **`--panel` + `--fallback-model` prohibition.** Like `--no-fallback` + `--fallback-model`
   (line 678), `--panel` + `--fallback-model` should throw: the panel IS the fallback
   machinery — it doesn't make sense to specify both a custom fallback model AND a panel.

---

## Verification Strategy (Acceptance Tests)

Every test is a **user-level e2e** — invoke `ocask` via the installed symlink, check
rc + stdout + stderr bytes. A silent rc=0 with 0 bytes is a FAILURE.

### Test 1: unanimous APPROVED
```
ocask --model deepseek-v4-pro --provider opencode --task "Review: code is fine" --require-verdict --panel --json
```
- rc=0
- stdout: JSON with `outcome: "judgment"`, `verdict: "APPROVED"`, `consensus.agreement: true`,
  `consensus.judgments_count: 2`
- stderr: empty (no errors)

### Test 2: panel quorum failure (both members time out)
```
ocask --model deepseek-v4-pro --task "..." --require-verdict --panel --timeout-ms 100 --json
```
- rc=30
- stdout: JSON with `outcome: "no-judgment"`, `verdict: null`, `reason: "quorum_failure"`,
  `consensus.judgments_count: 0`
- stderr: contains `ocask error:` with non-zero bytes

### Test 3: 1 of 2 members abstains → quorum failure
```
(Mock or use a provider that's guaranteed to fail fast for one family)
```
- rc=30
- `consensus.judgments_count: 1` (below K=2), `degraded: true`
- The 1 surviving judgment is recorded in `members` but NOT acted on

### Test 4: absolute deadline enforced
```
ocask --model deepseek-v4-pro --task "..." --require-verdict --panel --timeout-ms 5000
```
- Total wall-clock ≤ ~7s (5s timeout + overhead)
- NOT 10s (5s per member × 2)
- Timed-out members appear as abstentions

### Test 5: --panel + --no-fallback
```
ocask --model deepseek-v4-pro --task "..." --require-verdict --panel --no-fallback --json
```
- All members routed through identity-preserving transports
- No model swaps

### Test 6: --panel + --cross-verify conflict
```
ocask --model deepseek-v4-pro --task "..." --require-verdict --panel --cross-verify
```
- Should throw: `--panel and --cross-verify are mutually exclusive`

### Test 7: --panel + --fallback-model conflict
```
ocask --model deepseek-v4-pro --task "..." --require-verdict --panel --fallback-model qwen3.7-plus
```
- Should throw: `--panel cannot be combined with --fallback-model`

### Test 8: regression — existing --cross-verify still works
```
ocask --model deepseek-v4-pro --task "..." --require-verdict --cross-verify --provider opencode
```
- Should produce buddy check result (no panel behavior)
- Existing cross-verify tests pass unchanged
