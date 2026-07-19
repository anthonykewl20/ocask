# Prototype findings — verdict-contract abstention & the two-step fix

**Question:** Is ocask's review abstention (15→32→83% no-verdict, `reply-unusable`/`MODEL_OUTPUT`)
an *extraction-side* failure that a two-step approach (free-form review → tolerant/second-pass
verdict extraction) recovers — lifting recall without exploding FP vs the strict one-step
`--require-verdict` contract?

**Answer: YES (validated at N=20, control arm), with one refinement.**

## Evidence (same 20 corpus cases, control arm, single iteration)

| variant | recall | FP | notes |
|---|:-:|:-:|---|
| strict `--require-verdict --json` | 0.60–0.70¹ | 0.20–0.30¹ | 4 abstentions/run; defensive WARNINGs on clean = FP |
| naive two-step (no review framing) | 0.50 | **0.00** | recovered 2 abstentions, fixed 2 FPs, **lost 3 catches to task-drift** |
| **framed two-step** (review-only system prompt → extract) | **0.70** | **0.00** | recovered abstention, fixed 3 FPs, held recall |

¹ strict is **flaky run-to-run at temp 0** — an independent finding: abstention is largely
*transient*, so the T08 abstention rates overstate a stable failure and simple retries would
recover much of it.

## What we learned
1. **The strict verdict contract causes BOTH failure modes.** It produces abstentions
   (`reply-unusable` when the reply doesn't match the JSON/`VERDICT:` shape) AND false positives
   (the model emits a defensive `WARNING` on clean code to satisfy "give a verdict"). Dropping the
   *format* constraint fixed both: FP 0.30 → 0.00.
2. **But you must keep the review INTENT.** A naive free-form call (format dropped *and* framing
   lost) causes **task-drift** — deepseek responds as if *applying* the diff ("the refactor has
   been applied…") instead of critiquing it, so extraction reads APPROVED and real bugs are missed
   (recall 0.60→0.50). Re-asserting a review-only system prompt restored recall to 0.70.
3. **Extraction should be tolerant + two-step.** A cheap second pass ("classify this review into
   APPROVED/WARNING/BLOCKED") + last-verdict-wins regex recovered verdicts that the strict parser
   rejected. This matches the research (`docs/research/verdict-contract-abstention.md`): constrain
   only the final verdict field, not the reasoning.
4. **Abstention is partly flaky** → a bounded retry + one repair re-ask is a cheaper first fix that
   targets the transient share directly.

## Recommended first improvement (baseline-gated)
Change the ocask review path so the verdict is produced by **framed free-form review → tolerant +
one-repair/second-pass extraction**, instead of a single strict `--require-verdict` call.
Expected effect vs the frozen control baseline (0.60 recall / 0.10 FP): recall held-or-up, **FP
down toward 0**, abstention down. Cost: ~2× calls per review (token guardrail consideration).
Must be re-run through the full 3-arm × 3-iter harness and pass the frozen-baseline gates before
shipping.

## Caveats
Single-iteration (no flip-rate); N=20 control-arm only; strict baseline is itself flaky; one
residual lost catch (js-019) shows the free-form review still occasionally mis-frames. Directional
and strong, not yet gate-passed.
