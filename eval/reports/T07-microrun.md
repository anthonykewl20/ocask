# T07 — Live 2-case micro-run: results, cap derivation, anchor calibration

System under test: `ocask.mjs` @ origin/main (worktree). Run: 2 cases (buggy anchor `js-009`,
clean `js-002`) × 3 arms (control=`--lens general`, lens=`--lens code-review`, panel=`--panel`
cross-family) × 3 iterations, `--require-verdict --json --temperature 0 --timeout-ms 900000`.
18 live calls. Driver: `.model-flow/t07/run-t07.mjs` (dev scratch, reuses reviewed
`runOcaskArm` + `aggregate`).

## Pipeline validation (AC 2) — PASS with caveats
Real ocask output flows end-to-end through parse → arm rows → aggregate. APPROVED/BLOCKED parse
correctly; abstentions (`exit=30`, `PANEL NO-JUDGMENT`, quorum failures) parse to `verdict=null` /
`parse_ok=false`; cross-family panel members are captured. THREE measurement gaps surfaced (below).

## Verdict distribution (the headline finding)
11 NULL (abstention / no parseable verdict) · 6 APPROVED · 1 BLOCKED, across 18 calls.
**61% of live calls produced no verdict** — deepseek-v4-pro fails the `--require-verdict` contract
(`MODEL_OUTPUT`) very frequently on these diffs (consistent with `ocask doctor`: MODEL_OUTPUT 96,
TIMEOUT 80 for deepseek). Comparable rows: control 3/6, lens 4/6, panel 0/6.

- Clean `js-002`: control APPROVED×3 (correct), lens APPROVED×3 (correct), panel NO-JUDGMENT×3.
- Buggy `js-009`: control null×3, lens null,null,BLOCKED, panel NO-JUDGMENT×3.
- (A pre-run single smoke of control on `js-009` returned BLOCKED — so the arm is *highly* flaky.)

## Cost (AC 4) — derived from `ocask cost` cumulative delta
Total micro-run: **$0.0401 / 18 calls ≈ $0.0022 per call.**
Per model: deepseek-v4-pro +$0.0069 (12 solo calls, ~$0.0006 each — cheap, many abstain fast);
cross-family panel members qwen3.7-max +$0.0285 + qwen3.7-plus +$0.0048 (6 panel calls) — the panel
arm is the cost driver (~$0.0055/panel call).

## Full-run cap (AC 5)
Full baseline = 20 cases × 3 arms × 3 iters = 180 arm-invocations (~270 model-calls counting panel
members). Extrapolation: solo ~120 calls × $0.0006 ≈ $0.07 + panel ~60 calls × $0.0055 ≈ $0.33 →
**≈ $0.40**. 1.2× = **$0.48**. **Recorded cap: $1.00** (safe margin; the plan's $40–50 guess was
~50× too high — real DeepSeek pricing is $0.27/$1.1 per Mtok).

## Anchor calibration (AC 3)
`js-009` is **missed by all arms at case level (recall=0)** → it already leaves headroom ("barely
missed"). Caveat: it is missed mostly via *abstention*, not confident-APPROVE. One lens iteration
did catch it (BLOCKED), so a better lens has room to convert misses → catches. Decision: **freeze
`js-009` as the anchor as-is**, documenting the miss-via-abstention characteristic.

## BLOCKING gaps to fix BEFORE the T08 full baseline
Freezing a baseline now would bake in artifacts, because abstention (the dominant real outcome) is
mishandled:
1. **Clean-case abstention is not scored as FP.** T04 says panel no-consensus on clean ⇒ FP, but
   `aggregate` excludes null-verdict rows, so panel `fp_rate=0` despite NO-JUDGMENT×3 on `js-002`.
2. **Flip-rate ignores abstention instability.** lens `null,null,BLOCKED` is real instability but
   `flip_rate=0` (null rows dropped from flip opportunities).
3. **No per-row tokens / TER.** ocask `--json`/`--metadata` expose no per-call token count, so
   `tokens_used=null`, `tokens/case=0`, TER is not computable per-row. Cost must be taken from
   `ocask cost` deltas (as done here), or ocask must expose tokens.

Additionally: **the abstention rate itself (61%) is the biggest "where ocask fails" signal** and
should headline the T08 report — the review path frequently returns no judgment at all.

## Recommendation
Fix gaps 1–3 (abstention-as-first-class outcome: clean-abstention→FP, abstention counted in flip
opportunities, tokens/cost sourced from `ocask cost`) — a focused harness change — THEN run T08
under the $1 cap. T08 on today's pipeline would report misleading zeros.
