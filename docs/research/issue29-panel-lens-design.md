# Issue #29 — Per-Member Lens for High-Risk Panels

**Status:** architecture decision (NO source edits)
**Date:** 2026-07-18
**Based on:** landed #23 consensus panel (`computeConsensus`, `runPanel`), landed risk-based
selection (`selectPanel`, `--risk`), current `ocask.mjs` (buildPrompt ~265, LENS_FRAMEWORKS
~313, runPanel ~559, computeConsensus ~496, selectPanel ~236).

---

## Context

The consensus panel (`--panel`) + risk-based selection (`--risk`) landed. The `default` risk
tier uses a single lens (the caller's `--lens` value or `'general'`) applied identically to
all panel members. This is correct for `default` — cross-family agreement on a single
dimension is the core value.

For HIGH risk, we want DIVERSE coverage: the panel should apply multiple lenses (e.g.
security + code-review + architecture) so it catches more classes of defect. A migration
that touches auth, billing, and the schema needs a security review, a code-correctness
review, and an architecture review — not just one.

The question is: **how do diverse lenses compose with the AGREEMENT-based consensus
machinery (#23)?**  When members review under DIFFERENT lenses, they are not answering the
same question. Member A (security) answers "is this secure?" and Member B (code-review)
answers "is this correct?" — these are different dimensions, not votes on one proposition.

---

## Decision 1 — CONSENSUS vs COVERAGE (THE CRUX)

### The allocation grid with 2 families and D lenses

We have exactly 2 operational families (deepseek, qwen — `modelFamily` at
`providers/factory.mjs:99` recognizes no others). Each panel member is a (family, lens)
slot. The question is how to allocate D lenses across 2 members:

| Strategy | How lenses are distributed | Cross-model verification per lens | Changes to computeConsensus |
|---|---|---|---|
| **(a) Coverage** | Each member gets different lenses | None — 1 model per lens | Complete rewrite: union, not vote |
| **(b) Per-lens consensus** | Each lens gets a sub-panel of N members | Would need N≥2 per lens | Kept per sub-panel; combining layers needed |
| **(c) Multi-lens prompt** | All members get ALL lenses | Full — 2 models per lens | ZERO changes |

### (a) COVERAGE model — union of concerns

Each member reviews under a different lens. Aggregation is a union:
- Any lens returns BLOCKED → BLOCKED
- No BLOCKED, any WARNING → WARNING
- All APPROVED → APPROVED

This is NOT majority voting. It is conservative dimension-by-dimension coverage: if any
dimension fails, the whole review fails.

The fatal problem with 2 families: each lens is checked by exactly ONE model. If the
security-lens member abstains (timeout, auth failure), the security dimension is UNCHECKED.
For high risk, that is a coverage gap — you explicitly needed security review and didn't
get it. This MUST be a quorum failure. But the quorum concept is per-dimension, not
per-panel — there's no existing machinery for that.

A single-model security BLOCKED also has no cross-verification. The salvage addressed this
with N=5 and overlapping lens assignments (each lens covered by ≥2 members). With 2
families, overlapping coverage is impossible — every lens is a single point of failure.

**Verdict: rejected for the first deliverable.** Requires a fundamentally new aggregator
(multi-dimensional, not vote-based), per-lens quorum semantics, and a coverage model that
only becomes reliable at N≥3.

### (b) PER-LENS CONSENSUS — sub-panels per dimension

Run a full cross-family sub-panel per lens (security sub-panel + code-review sub-panel),
each with its own K-of-N agreement, then combine verdicts.

With 2 families and D lenses, each sub-panel needs at least 2 cross-family members (the
independence invariant from #23). That requires 2 × D families. For D=3 (security,
code-review, architecture), you need 6 families. For D=2, you need 4. With 2 operational
families, the smallest sub-panel is N=1 — consensus is meaningless (K=1 gives a
single-model verdict, violating the "a single-model panel is not a panel" principle from
#23 Decision 1).

**Verdict: rejected as currently infeasible.** Becomes viable when 3+ families are
operational (can run N=2, K=2 sub-panels per lens with overlapping family assignments).

### (c) MULTI-LENS PROMPT — all members review all lenses

Every member's prompt includes ALL high-risk lens frameworks. Both members answer the SAME
multi-dimensional question: "review under security, code-review, and architecture lenses."

Why this works:
- **Same question** → majority vote is still meaningful (they are voting on the same
  multi-dimensional review)
- **Cross-model on every lens** → both models apply security, code-review, and
  architecture. A hallucinated security BLOCKED from one model is cross-checked by the
  other model applying the same lens.
- **Zero changes to `computeConsensus`** (`ocask.mjs:496`) — it never learns about
  individual lenses. It sees N verdicts on the same question and votes.
- **Fail-closed guarantee preserved** — if one member abstains, fewer than K=2 judgments
  → `degraded: true` → panel no-judgment (exit 30). The surviving member's verdict on ALL
  lenses is recorded but NOT acted on, exactly as #23 Decision 2 specifies.
- **Buildable with 2 families** — the prompt is enriched, not the member allocation.
  Every member gets the same enriched prompt.

This is NOT strictly "per-member lens" — every member applies the same multi-lens set. But
it achieves the GOAL of diverse coverage (multiple issue classes checked) while preserving
the agreement-based fail-closed semantics that make the panel trustworthy.

**RECOMMENDATION: (c) for the first deliverable.**

It satisfies both constraints from the brief:
- (i) Fail-closed guarantee: entirely preserved. `computeConsensus` is untouched;
  abstentions still prevent verdicts; K=2 still requires both judgments.
- (ii) Buildable with 2 families: yes. No new models, no new sub-panels. Prompt enrichment
  only.

### The graduation path to true per-member diversity

When 3+ families become operational (kimi, minimax, or mimo — whichever gets
`modelFamily` + identity-transport entries first), we can evolve to a coverage matrix:

```
Family 1 (deepseek):  security + code-review
Family 2 (qwen):      code-review + architecture
Family 3 (kimi):      architecture + security
```

Each lens is covered by exactly 2 members (overlapping coverage). Abstention of one member
leaves the lens still covered by the other. The aggregation remains coverage-based
(union) but each lens has cross-model verification. This is the natural graduation from the
multi-lens approach — same prompt-building machinery, different lens distribution.

---

## Decision 2 — LENS SET per risk tier

### Lenses for HIGH risk

The curated set for high risk is:

```js
const HIGH_RISK_LENSES = ['security', 'code-review', 'architecture'];
```

Rationale for each:
- **security** (`LENS_FRAMEWORKS.security`, `ocask.mjs:332`): injection surfaces,
  auth/credential exposure, data exposure, privilege boundaries, supply chain.
- **code-review** (`LENS_FRAMEWORKS['code-review']`, `ocask.mjs:314`): correctness,
  completeness, consistency, simplicity, Fowler's code smells.
- **architecture** (`LENS_FRAMEWORKS.architecture`, `ocask.mjs:322`): module boundaries,
  coupling/cohesion, deep vs shallow modules, seams, change amplification, invariants.

Together they cover: security vulnerabilities, logic bugs, and structural regressions —
three orthogonal defect classes. A change that passes all three has solid evidence of
correctness.

Why NOT `tdd`, `maintainability`, `deep-modules`, or `general`? The three selected lenses
cover the audit gate's core concern: "will this change cause a production incident?"
Security bugs, correctness bugs, and architecture regressions cause incidents. TDD quality,
maintainability, and deep-module depth are important but are second-order concerns for the
audit gate — they affect velocity, not immediate safety. The set is kept at 3 to avoid
prompt bloat (each framework is ~10-30 lines; 3 frameworks is ~50 lines of lens text,
which is substantial but manageable).

### Lenses for DEFAULT risk

Unchanged: the caller's `--lens` value (default `'general'`). All members get the same
single lens. This is the existing #23 behavior.

### Lenses for TRIVIAL risk

N/A — solo mode, no panel. The single model runs the standard (non-panel) path with the
caller's lens. No multi-lens enrichment occurs.

### Configuration: constant map, overridable?

`HIGH_RISK_LENSES` is a module-level constant. It is NOT overridable via `--lens` for high
risk. The rule:

> When `--risk high` is active, the curated multi-lens set (`high-risk-full`) is ALWAYS
> used. Any explicit `--lens` value is ignored.

Rationale: high risk means "give me the most thorough review possible." Allowing `--lens
security` to narrow the review defeats the purpose. A user who wants a single-lens
cross-family review should use `--risk default --lens security` instead. The CLI should not
encourage dangerous combinations — silently narrowing a high-risk review is worse than
refusing to honor the flag.

### Storage: compound lens key in LENS_FRAMEWORKS

The multi-lens set is stored as a computed entry in `LENS_FRAMEWORKS`:

```js
// After the existing LENS_FRAMEWORKS definition (~line 369)
LENS_FRAMEWORKS['high-risk-full'] = HIGH_RISK_LENSES
  .map(k => LENS_FRAMEWORKS[k])
  .join('\n');
```

This means `buildPrompt` (`ocask.mjs:265`) requires ZERO changes. The compound lens key
flows through the existing `lens` parameter — `buildPrompt` at line 271 checks
`LENS_FRAMEWORKS[lens]` and finds the concatenated frameworks. The `lens.toUpperCase()`
on the AUDIT FRAMEWORK header will render as `HIGH-RISK-FULL`, which is descriptive
enough.

`VALID_LENSES` (line 371) must include `'high-risk-full'` so `--lens high-risk-full`
passes validation, but the CLI key is never exposed to users — `--risk high` activates it
internally.

---

## Decision 3 — runPanel PER-MEMBER PROMPT

### Current state

`runPanel` (`ocask.mjs:559`) builds ONE prompt at line 575:

```js
const prompt = buildPrompt({ taskText, systemText, contextText,
  jsonMode, requireVerdict, maxTokens, lens });
```

This single prompt string is prepended with `DELEGATED_IDENTITY_PREFIX` and sent to EVERY
member (line 589):

```js
prompt: DELEGATED_IDENTITY_PREFIX + prompt,
```

Every member reviews under the SAME lens. This is correct for the agreement model.

### With multi-lens (option c)

The change is a ONE-LINE substitution in `runAsk` (`ocask.mjs:734-739`). Currently:

```js
if (usePanel) {
    const panelResult = await runPanel({
      model, taskText, systemText, contextText, jsonMode, requireVerdict,
      lens, temperature, maxTokens, timeoutMs, provider, ...
```

Change to:

```js
if (usePanel) {
    const panelResult = await runPanel({
      model, taskText, systemText, contextText, jsonMode, requireVerdict,
      lens: panelSelection.strict ? 'high-risk-full' : lens,
      temperature, maxTokens, timeoutMs, provider, ...
```

`runPanel` receives `'high-risk-full'` as its `lens` parameter and passes it through to
`buildPrompt` at line 575 — exactly as it does today. Zero changes inside `runPanel`.

### Future: per-member diversity (not in first deliverable)

When true per-member lens assignment arrives (3+ families), the seam is `runPanel` line
575. The prompt-building moves inside the per-member loop at line 579:

```js
const attempts = members.map(async (member, index) => {
  const memberPrompt = buildPrompt({ ..., lens: member.lens });
  ...
  prompt: DELEGATED_IDENTITY_PREFIX + memberPrompt,
});
```

Each member's config would include a `lens` (or `lenses`) field populated by `selectPanel`
during resolution. This is a straightforward refactor — it moves the `buildPrompt` call
from line 575 into the loop — but it is NOT needed for the first deliverable.

### Why not call `buildPrompt` per-member today?

Because with option (c), every member gets the SAME multi-lens prompt. Calling
`buildPrompt` once and reusing the string is correct and more efficient (one hash
computation, one string allocation). The per-member call adds zero value until lenses
diverge.

---

## Decision 4 — AGGREGATION + EXIT BANDS

### computeConsensus: UNCHANGED

With option (c), all members answer the same multi-lens question. `computeConsensus`
(`ocask.mjs:496`) operates on member verdicts — it does not know or care which lenses
produced them:

1. Collect judgments (class:`'judgment'` with canonical verdict).
2. If `judgments_count < K` → `degraded: true`, `consensus_verdict: null`.
3. Count votes: majority ≥K → that verdict.
4. BLOCKED tiebreaker: any BLOCKED with quorum met → BLOCKED.
5. Split non-BLOCKED → WARNING.

The algorithm is lens-agnostic. It works identically whether the prompt contained 1 lens or
3. The fail-closed guarantee holds: abstentions never fake a verdict; a single surviving
member's verdict on all lenses is recorded but NOT acted on.

### Coverage gap analysis

The one nuance: in the multi-lens model, a member could produce APPROVED because it missed
a security issue that another member caught. In the agreement model, this is exactly what
the BLOCKED tiebreaker handles: one APPROVED + one BLOCKED → BLOCKED (the tiebreaker gives
BLOCKED the benefit of the doubt). With multi-lens prompts, this still works — both members
see the security lens, so if one sees a security issue and the other doesn't, the
tiebreaker applies.

### Exit bands (#11): UNCHANGED

| Outcome | `describeOutcome` | Exit code |
|---|---|---|
| Consensus APPROVED | `{ outcome: "judgment", verdict: "APPROVED" }` | 0 |
| Consensus WARNING | `{ outcome: "judgment", verdict: "WARNING" }` | 0 |
| Consensus BLOCKED | `{ outcome: "judgment", verdict: "BLOCKED" }` | 20 |
| Quorum failure | `{ outcome: "no-judgment", verdict: null, reason: "quorum_failure" }` | 30 |

`PANEL_QUORUM_CLASSIFICATION` (line 490), `exitCodeForOutcome` (line 973),
`describeOutcome` (line 988), and `buildJsonResponse` (line 1011) are ALL unchanged. The
multi-lens enrichment is entirely upstream of the contract layer.

---

## Decision 5 — SCOPE + ACCEPTANCE + CODE PLAN

### First deliverable

1. **`HIGH_RISK_LENSES` constant** — curated set `['security', 'code-review',
   'architecture']`.
2. **Compound lens key `'high-risk-full'` in `LENS_FRAMEWORKS`** — concatenation of the
   three lens frameworks.
3. **`runAsk` lens routing** — when `panelSelection.strict` (high risk), pass
   `'high-risk-full'` as the lens to `runPanel` instead of the caller's `--lens` value.
4. **CLI behavior** — `--panel --risk high` automatically applies the multi-lens set.
   Explicit `--lens` is ignored for high risk.

### Explicitly DEFERRED (follow-up issues)

| Feature | Reason |
|---|---|
| True per-member lens assignment (different lenses per member) | Requires ≥3 operational families for cross-model coverage per lens; viable when kimi/minimax/mimo get `modelFamily` support |
| Per-member prompt building in `runPanel` | Only needed when lenses diverge per member; with multi-lens, one prompt serves all |
| Coverage-based aggregation (option a from Decision 1) | Requires a new aggregator + per-lens quorum semantics; only reliable at N≥3 |
| User-facing `--lenses` flag (array of lenses) | `--risk high` activates the curated set internally; explicit control adds CLI surface for negligible gain until per-member diversity arrives |
| `buildPrompt` lens array support | The compound key approach is zero-change to `buildPrompt`; array support is the right generalization but not needed for the first ship |

### Acceptance criteria (user-level e2e, real CLI, rc/stdout/stderr)

Silent rc=0 with 0 bytes is a FAILURE (per map standing preference).

1. **`--panel --risk high` applies multi-lens prompt:**
   ```
   ocask --model deepseek-v4-pro --task "review auth change" --require-verdict --panel --risk high --json
   ```
   - Both panel members receive prompts containing SECURITY, CODE-REVIEW, and ARCHITECTURE
     audit framework sections.
   - Consensus computed normally (majority vote on the combined review).
   - Exit 0 for APPROVED/WARNING, exit 20 for BLOCKED, exit 30 for quorum failure.
   - `--json` output includes `consensus` and `members` (unchanged structure).

2. **`--panel --risk high` ignores explicit `--lens`:**
   ```
   ocask --model deepseek-v4-pro --task "review" --require-verdict --panel --risk high --lens security --json
   ```
   - The multi-lens set `high-risk-full` is used, NOT `security`.
   - Both members review under security + code-review + architecture.

3. **`--panel --risk default --lens security` uses single lens:**
   ```
   ocask --model deepseek-v4-pro --task "review" --require-verdict --panel --risk default --lens security --json
   ```
   - Both members review under the single `security` lens.
   - Unchanged #23 behavior.

4. **`--panel` without `--risk` still works (default → auto → default):**
   ```
   ocask --model deepseek-v4-pro --task "review" --require-verdict --panel --json
   ```
   - Risk = `auto` → no diff context → falls back to `default`.
   - Uses the caller's `--lens` (or `'general'`).
   - Existing #23 acceptance tests pass unchanged.

5. **`--risk high` without `--panel` is rejected:**
   ```
   ocask --model deepseek-v4-pro --task "review" --risk high --json
   ```
   - Error: `--risk requires --panel` (existing guard at `ocask.mjs:1055`).

6. **Quorum failure on high risk still works:**
   ```
   ocask --model deepseek-v4-pro --task "review" --require-verdict --panel --risk high --timeout-ms 100 --json
   ```
   - Exit 30.
   - `outcome: "no-judgment"`, `reason: "quorum_failure"`.
   - `consensus.judgments_count: 0` (or <2).

7. **BLOCKED tiebreaker still works with multi-lens:**
   - One member returns BLOCKED (security issue), other returns APPROVED.
   - Consensus = BLOCKED (tiebreaker — one BLOCKED with quorum met).
   - Exit 20.

### Code plan — exact functions/seams with file:line

| What | File:line | Change |
|---|---|---|
| `HIGH_RISK_LENSES` constant | `ocask.mjs` ~L370 | **NEW** — `['security', 'code-review', 'architecture']` |
| `LENS_FRAMEWORKS['high-risk-full']` | `ocask.mjs` ~L369 | **NEW** — concatenation of the three lens frameworks |
| `VALID_LENSES` | `ocask.mjs:371` | **MODIFY** — add `'high-risk-full'` to the array |
| `runAsk` lens passthrough | `ocask.mjs:737` | **MODIFY** — `lens: panelSelection.strict ? 'high-risk-full' : lens` |
| `buildPrompt` | `ocask.mjs:265` | **UNCHANGED** — `LENS_FRAMEWORKS[lens]` resolves the compound key |
| `runPanel` | `ocask.mjs:559` | **UNCHANGED** — receives lens parameter, passes to `buildPrompt` at L575 |
| `computeConsensus` | `ocask.mjs:496` | **UNCHANGED** — lens-agnostic majority vote |
| `selectPanel` | `ocask.mjs:236` | **UNCHANGED** — already returns `strict: true` for high risk |
| `describeOutcome` | `ocask.mjs:988` | **UNCHANGED** |
| `exitCodeForOutcome` | `ocask.mjs:973` | **UNCHANGED** |
| `buildJsonResponse` | `ocask.mjs:1011` | **UNCHANGED** |
| `runMain` | `ocask.mjs:1027` | **UNCHANGED** — `risk` already propagated through |
| `PANEL_QUORUM_CLASSIFICATION` | `ocask.mjs:490` | **UNCHANGED** |

**Total change surface: 3 lines of code, 2 new data definitions.** No function signatures
change. No control flow changes. The existing machinery reacts to the enriched prompt
identically to how it reacts to a single-lens prompt.

### Architectural assessment (self-applied audit framework)

- **Module boundaries**: The change is entirely within `ocask.mjs`. No new imports, no new
  cross-module calls. The lens system (`buildPrompt` + `LENS_FRAMEWORKS`) is the natural
  home for this enrichment — it already maps lens keys to prompt text; adding a compound
  key is an additive, non-breaking extension.
- **Coupling and cohesion**: Zero increase in coupling. The new constant and compound key
  are cohesive with their neighbors (`LENS_FRAMEWORKS` and `VALID_LENSES`). The `runAsk`
  change is a single ternary — it's adjacent to the existing `strict` check and reads like
  the existing code.
- **Depth**: `buildPrompt` is already a deep module (one call produces the entire prompt).
  The compound key makes it slightly DEEPER — more behavior (3 lenses) behind the same
  interface (one string key). The deletion test: if you deleted `'high-risk-full'`, the
  complexity of concatenating 3 frameworks would reappear in every caller that needs
  multi-lens review. The compound key earns its keep.
- **Seams**: `LENS_FRAMEWORKS` is the seam — add keys to configure behavior. The `strict`
  field on `selectPanel`'s return is the second seam — it already gates high-risk
  enforcement. Adding lens routing to the same gate uses an existing seam rather than
  creating a new one.
- **Change amplification**: A future change to the high-risk lens set (e.g. adding
  `deep-modules`) requires editing ONE line (`HIGH_RISK_LENSES`). The compound key is
  recomputed at module load from the array. A future need for per-member lens diversity
  changes code in ONE place (`runPanel` line 575 moves into the loop), not spread across
  callers.
- **Invariants**: Fail-closed is preserved: `computeConsensus` still requires ≥K real
  judgments and never produces a verdict from insufficient votes. The four-way caller
  contract (#11) is untouched — exit codes, JSON envelope, and stderr behavior are
  unchanged. The `PANEL_COUNTERPART_BY_FAMILY` invariant (cross-family members only) is
  unaffected — the lens set is orthogonal to model selection.

---

## Summary

| Decision | Answer |
|---|---|
| 1. CONSENSUS vs COVERAGE | **Multi-lens prompt (option c).** All members receive all high-risk lenses in one prompt. Agreement-based consensus (majority vote) is preserved. Fail-closed guarantee is untouched. True per-member diversity is deferred until 3+ families are operational. |
| 2. Lens set per risk tier | High: `['security', 'code-review', 'architecture']`. Default: caller's `--lens` (unchanged). Trivial: N/A. Stored as `HIGH_RISK_LENSES` constant + computed `'high-risk-full'` key in `LENS_FRAMEWORKS`. Not overridable via `--lens` on high risk. |
| 3. runPanel per-member prompt | One-line lens routing in `runAsk`: `panelSelection.strict ? 'high-risk-full' : lens`. `runPanel` and `buildPrompt` are unchanged. Per-member prompt building (future) moves the `buildPrompt` call from `runPanel:575` into the per-member loop at `runPanel:579`. |
| 4. Aggregation + exit bands | `computeConsensus` is UNCHANGED. Exit bands: APPROVED/WARNING→0, BLOCKED→20, quorum failure→30. The BLOCKED tiebreaker handles within-lens disagreements naturally (both models see all lenses). |
| 5. Scope | First deliverable: `HIGH_RISK_LENSES`, compound lens key, `runAsk` lens routing. 3 lines of code change, 2 new data definitions. Deferred: true per-member lens distribution, coverage-based aggregation, `--lenses` CLI flag. |

### Honest limit of 2-family constraint on option (b)

Option (b) — per-lens consensus sub-panels — is the most architecturally pure model:
independent cross-family verification on EACH dimension. But with 2 families, it is
physically impossible: each sub-panel needs ≥2 cross-family members, and we have exactly 2
families total. You cannot allocate 2 families across D lenses with N≥2 per lens. The math
is `D × 2 ≤ 2` → `D ≤ 1` — exactly one lens, which is the current single-lens panel.

The multi-lens approach (option c) is the honest path: it tells both models "review under
ALL these lenses" and lets the consensus machinery verify that both families agree on the
combined assessment. It loses the ability to isolate which lens produced a disagreement, but
it gains the ability to check all lenses with cross-model verification — a trade that is
correct for the 2-family constraint.

When a third family arrives, option (c) naturally evolves: lenses can be distributed across
members with overlapping coverage (e.g. family A: {security, code-review}, family B:
{code-review, architecture}, family C: {architecture, security}). Each lens is covered by 2
families, each family carries 2 lenses. The prompt-building machinery is identical — only
the assignment table changes.
