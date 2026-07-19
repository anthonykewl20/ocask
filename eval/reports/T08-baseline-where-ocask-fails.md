# T08 — Frozen baseline & "where ocask fails"

**Run:** 20 JS cases (10 buggy / 10 clean) × 3 arms × 3 iterations = 180 live calls against
`ocask.mjs`@origin/main. `--require-verdict --json --temperature 0`. Concurrency 5, **$1 cap**.
**Completion 100% (180/180), spent $0.4213** — baseline frozen (≥80% gate met). Raw data:
`eval/baseline/frozen-baseline.json`. Metrics use case-level collapse (majority of 3 iterations);
abstention (no parseable verdict) is a first-class outcome.

## Baseline (per arm)

| arm | lenient recall | FP rate | abstention | flip rate | raw no-verdict |
|-----|:-:|:-:|:-:|:-:|:-:|
| **control** (solo, `--lens general`) | **0.60** | 0.10 | 0.15 | 0.33 | 9/60 (15%) |
| **lens** (`--lens code-review`, same model) | 0.70 | 0.40 | 0.32 | 0.57 | 19/60 (32%) |
| **panel** (`--panel`, cross-family) | 0.10 | 0.90 | 0.00¹ | 0.20 | 50/60 (83%) |

¹ Panel no-verdict is mapped to FP(clean)/miss(buggy) by the T04 conservative fallback, so it
surfaces as FP/miss rather than `abstention_rate`. The **raw** panel quorum-failure rate is **83%**.

`tokens_per_case` is `null` for every arm — ocask exposes no per-call token count; cost is taken
from `ocask cost` deltas (see below). TER is therefore `n/a` this cycle.

## Finding 1 — the `code-review` lens is not a real improvement
Lens vs Control: recall **0.60 → 0.70** looks like a gain, but the raw catch count is **6 → 7**
(Δ = 1 buggy case). The significance gate requires Δcatches ≥ 2 → **not significant** (one lucky
case at n=10). Meanwhile the lens **regresses every guardrail**:
- FP **0.10 → 0.40** (4× more false alarms on clean code),
- abstention **15% → 32%** (the lens makes ocask fail to answer twice as often),
- flip-rate **0.33 → 0.57** (much less stable across identical repeats).

**Verdict: the lens trades a statistically-insignificant +1 catch for a large, real FP + stability
regression.** This is the "lenses are fake" hypothesis, now a number: the audit-framework prose
does not buy detection.

## Finding 2 — the cross-family panel adds *negative* value
Panel vs Control: recall **0.60 → 0.10** (catches 6 → 1) and FP **0.10 → 0.90**
(**significant regression**). The cause is an **83% quorum-failure rate** — the panel almost never
reaches consensus, so under the conservative fallback it misses real bugs and is scored as crying
wolf on clean code. Computed **panel-vs-best-single-member** (`panel_vs_best_member` in the frozen
baseline): consensus recall **0.10** vs best member (deepseek) **0.00** — i.e. the panel's members
*individually* catch nothing when run inside the panel (they abstain), so consensus adds only a
marginal +0.10 over its own broken members, and the entire panel path (0.10) is crushed by a plain
**solo** model (control **0.60**). **Verdict: the panel consensus is worse than a single model on
this corpus — it should not be the default for review.**

## Finding 3 — abstention is the dominant failure mode
No-verdict/abstention rises monotonically **solo 15% → lens 32% → panel 83%**. ocask frequently
fails the `--require-verdict` contract entirely (`MODEL_OUTPUT`), and every added layer (lens prose,
panel consensus) makes it *more* likely to return nothing usable. **The first reliability work
should target verdict-contract adherence, not new lenses.**

## Cost
Total measured: **$0.4213 / 180 calls ≈ $0.0023/call** (DeepSeek $0.27/$1.1 per Mtok). Solo calls
are ~$0.0006 (cheaper still when they abstain early); the **cross-family panel is the cost driver**
(qwen members) — so the panel arm costs the *most* while delivering the *worst* detection. Per-arm
token/TER accounting is blocked until ocask exposes per-call tokens.

## What the first improvements should target (ranked)
1. **Verdict-contract reliability** — 15–83% of calls return no judgment; fix this before anything
   else (it caps the achievable recall of every arm).
2. **Kill or fix the panel default** — 83% quorum failure makes cross-family consensus a net
   negative; either fix consensus robustness or stop defaulting review to it.
3. **Justify or drop the `code-review` lens** — no significant recall lift, clear FP/stability cost.
4. **Expose per-call tokens in ocask `--json`** — required to make TER and the token guardrail bind.

## Guardrail status (candidate arms vs control baseline)
- **Lens:** recall gain not significant; FP regression → **fails** the must-not-regress guardrails.
- **Panel:** significant FP regression + recall collapse → **fails**.
Neither arm qualifies as an improvement over the plain solo control under the frozen gates.
