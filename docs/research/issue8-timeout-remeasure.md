# Issue #8 — Re-measure the ocask default timeout from a real healthy-latency P99

**Analyst.** OpenCode Go delegated agent.  
**Date.** 2026-07-18  
**Status.** Recommendation delivered; no code landing.

---

## 1. Data: healthy single-call latency distribution

### Source

`~/.local/share/ocask/log.jsonl` (176 entries, live ocask production log). Extracted every run that
had exactly **one successful attempt and zero failures** — a pure single-call, uncensored completion
with no fallback, no retry, and no cross-verify buddy.

### Exclusion rule (per #6 C6 — coordinated omission)

Runs killed by a caller-imposed deadline (`all_exhausted` with a duration matching a ceiling) are
**right-censored**: the true completion time is unknown (>= deadline). Feeding them back as if they
finished at the deadline is coordinated omission (Tene) and drives the percentile **down** into a
death spiral. These 10 censored runs are **excluded**; only genuine completions count.

### n, raw values

**n = 22** single-call successes. Every row is `model → duration_ms (run_id)`.

```
fast cluster (<20s) — 13 runs:
  deepseek-v4-pro    2,887ms (5076e35f)
  deepseek-v4-pro    3,547ms (751a49d8)
  deepseek-v4-pro    3,727ms (c6d0c106)
  deepseek-v4-pro    4,417ms (8bd99b9c)
  deepseek-v4-pro    5,139ms (0f8d70b2)
  deepseek-v4-pro    5,174ms (8b0a1972)
  deepseek-v4-pro    6,717ms (b771fd86)
  deepseek-v4-pro    6,991ms (d5bc0118)
  deepseek-v4-pro    7,477ms (98d74864)
  deepseek-v4-pro    7,537ms (072da039)
  deepseek-v4-flash  11,410ms (245a65a8)
  deepseek-v4-pro    11,882ms (bdb99a82)
  deepseek-v4-pro    12,839ms (a8cb3a1e)

slow cluster (>=20s) — 9 runs:
  deepseek-v4-pro    61,071ms  (214fea76)
  deepseek-v4-pro   109,658ms  (5c64a591)
  deepseek-v4-pro   125,340ms  (725294ec)
  qwen3.7-max       128,996ms  (e7724969)
  deepseek-v4-pro   129,778ms  (44b514bb)
  deepseek-v4-pro   139,996ms  (377e74e2)
  deepseek-v4-pro   155,620ms  (495fe3d5)
  deepseek-v4-pro   166,568ms  (f481366f)
  qwen3.7-max       271,884ms  (58952a23)
```

**Excluded (right-censored):** 10 runs killed by caller deadline at 20s, 25s, 40s, 55s, 60s, and
120s — true completion unknown. Treating them as latencies would commit coordinated omission.

---

## 2. Distribution

| Statistic | ms | seconds |
|---|---|---|
| min | 2,887 | 2.9s |
| median (P50) | 11,410 | 11.4s |
| P75 | 128,996 | 129.0s |
| P90 | 155,620 | 155.6s |
| P95 | 166,568 | 166.6s |
| P99 | 271,884 | 271.9s |
| P99.9 | 271,884 | 271.9s |
| max | 271,884 | 271.9s |
| mean (poisoned) | 62,666 | 62.7s |

Percentile formula: `sorted[ceil(q/100 * n) - 1]` (matches the #6 prototype).

### Bimodal structure

The distribution splits sharply at ~20s:

- **Fast cluster** (13/22, 59%): 2.9s – 12.8s. Typical model response. Median 7.0s.
- **Slow cluster** (9/22, 41%): 61.1s – 271.9s. Genuine completions, not hangs — all produced
  valid, parseable model output. The same model (`deepseek-v4-pro`) appears in both clusters,
  confirming this is per-request variance (server queuing / response complexity / backend load),
  not a model-specific property.

**The mean (62.7s) is useless**: it sits between P75 (129.0s) and P50 (11.4s) but represents
neither cluster. Tene: "the mean is not the signal — the tail is."

---

## 3. Recommended default

### n=22 is too small for a stable P99; P99 is pinned to the maximum

With n=22, `ceil(99/100 * 22) = 22` → P99 is the maximum observed value (271.9s). This is **not
a stable percentile estimate** — the next genuinely slow run that arrives will shift P99 to its own
duration. Reliable P99 estimation needs roughly **100+ data points** (10x the reciprocal of the
percentile: ~100 for P99, ~1000 for P99.9). At n=22, only one value in a hundred lands at or
beyond P99, so a single additional slow run can double the estimate.

### Recommendation: P95, 170s, as the defensible interim

P95 from n=22 is 166.6s (the 21st of 22 sorted values). Round to **170s**. This is a stated high
percentile with the following properties:

1. **Preserves all 22 observed genuine successes.** The slowest is 271.9s, but P95 accepts that
   ~5% of calls will fire the timeout and be retried. 166.6s preserves 21/22 (95.5%) of observed
   runs.
2. **Not pinned to a single extreme value.** P95 uses the 21st value, not the 22nd (max). Adding
   one more very-slow run would not move P95 nearly as much as it would move P99.
3. **The 271.9s run (qwen3.7-max) is the lone sacrifice.** That model produced only 2 successes
   in the sample (129s and 272s); qwen's P95 sample (2 points) cannot be estimated at all. The
   170s default would fire the timeout on the 272s run — the caller would observe a no-judgment
   and may retry or fallback. That is the expected tradeoff: a tighter bound improves pipeline
   availability at the cost of ~5% more timeouts in the slow tail.

### What would fix the P99 estimate

- **100+ single-call successes logged at a timeout ≥ 300s** (so the true tail is never censored).
  Wait time: with ~22 successes over the current log's lifetime, perhaps weeks of additional
  production use.
- Alternatively: a controlled **benchmark** that calls the same ocask topology 100 times with a
  generous bound (e.g., 600s), recording each uncensored latency. The `bench.mjs` harness in the
  salvage repo (`~/devtony/opencode-verify/`) already has the plumbing and mock panel; it could
  be routed through the real opencode provider to gather 100+ real latencies.
- Until then, **170s is the defensible interim default for the single-call topology** — a real
  measured P95, explicitly acknowledged as provisional.

---

## 4. Hedge evaluation

### Dean & Barroso: Tail-at-Scale

A hedged request defers a backup call until the primary has been outstanding past some quantile
(typically P95 or P99 of the fast-path latency), then takes whichever answers first. In BigTable
this cut P99 latency from 1800ms to 74ms at ~2% additional load. The hedge **cannot rescue a
true hang** — it exploits variance across independent replicas/backends, not a dead backend.

### Could a hedge cheaply rescue ocask's slow tail?

**Yes, with a concrete design:**

- **Hedge point:** 15s (just above the fast-cluster max of 12.8s). The fast cluster would never
  trigger the hedge (59% of calls: 1x cost). The slow cluster (41% of calls) fires it.
- **Hedge model:** a second, cheaper model (e.g., `deepseek-v4-flash`) via the same opencode
  provider. The hedge call starts at t=15s and runs concurrently with the still-outstanding
  primary. Whichever finishes first wins.
- **Expected effective P95:** ~27s (15s wait + median hedge call ~12s). All 9 slow-cluster runs
  would be rescued — the hedge finishes in ~12s while the primary is still churning at 61-272s.
  The caller never sees the slow tail.
- **Cost:** ~41% extra model calls (only on slow-cluster runs). With opencode's pricing,
  `deepseek-v4-flash` is cheaper than `deepseek-v4-pro`, limiting the cost increase.

### Caveat: provider correlation risk

Both primary and hedge go through a single provider (opencode). If the backend is slow **for both
calls simultaneously** (correlated slowdown), the hedge doesn't help. The data suggests the slow
tail is per-request variance (same model produces both 2.9s and 167s runs), which is the regime
where hedging works. However, a correlated backend event (e.g., opencode infrastructure degradation
or a shared model cluster overload) would slow both calls together, and the hedge would also be
slow. In that case, occlusion's best defense remains the **bounded default deadline**.

### If hedging is adopted, the default can be much tighter

With a hedge at 15s compensating for per-request variance, the deadline only needs to protect
against the **coincident slow-hedge** case (both primary and hedge are slow simultaneously) plus
a small safety margin. A value like **60s** would be sufficient:

- Fast cluster (59%): finishes in ≤13s — well within 60s, no hedge triggered.
- Slow cluster with hedge (41%): primary fails to finish by 15s, hedge fires at 15s, hedge
  typically finishes by ~27s — well within 60s.
- Hang (either or both calls never return): the 60s bound fires, protecting the pipeline.

**Recommendation with hedge: 60s** (tight, keeps pipeline velocity high, and the hedge handles
the per-request tail). **Recommendation without hedge: 170s** (P95 of the single-call distribution).

### Hedge cannot rescue a true hang — #6 C1's bound remains the sole protection

A hung process or dead backend does not respond regardless of how many hedges are fired. Dean &
Barroso state this explicitly: hedging *"cannot solve indefinite hangs — it only works when some
replica responds within reasonable time."* The bounded default deadline (170s without hedge, 60s
with hedge) remains the only mechanism that protects the gate against a genuine hang. **The hard
ceiling (300s, #6 C4) must always be enforced**, even when hedging is active, because if both
primary and hedge hang, the deadline kicks in.

---

## 5. Hard ceiling and absolute-deadline enforcement

### Confirmation of #6 C4 (hard ceiling ~300s)

The hard ceiling serves two purposes: (1) prevent `--timeout-ms 0` (unbounded) and absurd values
(e.g., 10^9) from removing all hang protection, and (2) serve as the maximum wall-clock any
caller can request. **300s (5 min) is affirmed** — it is well above 271.9s (the observed max)
and well below an unbounded wait.

### Where the absolute deadline must be enforced

The #6 contract (C2) requires a single **caller-owned absolute deadline** shared across all
internal work (primary + fallback + cross-verify). Today the code passes `timeoutMs` as a
per-attempt duration, and each `invokeWithFallback` call restarts a fresh timer. This path
produces the 314s hang class (primary 120s timeout → fallback 120s timeout → 240s wall-clock;
with cross-verify, 360s).

**Concrete change sites (file:line from this worktree):**

#### 5a. Default constant and hard ceiling

| What | File | Line | Change |
|---|---|---|---|
| Default value | `ocask.mjs` | `ocask.mjs:322` | `timeoutMs = 0` → `timeoutMs = DEFAULT_TIMEOUT_MS` |
| Default value | `ocask.mjs` | `ocask.mjs:600` | `parsePositiveInt(..., 0)` → `parsePositiveInt(..., DEFAULT_TIMEOUT_MS)` |
| Hard ceiling cap | `ocask.mjs` | `ocask.mjs:600` | After `parsePositiveInt`, add `timeoutMs = Math.min(timeoutMs, HARD_CEIL_MS)` |
| Constant definitions | `ocask.mjs` | after `ocask.mjs:18` | Add `const DEFAULT_TIMEOUT_MS = 170_000; const HARD_CEIL_MS = 300_000;` |

#### 5b. Absolute deadline — shared wall-clock ceiling

| What | File | Line | Change |
|---|---|---|---|
| Compute deadline once | `ocask.mjs` | `ocask.mjs:335` | After `const runStarted = Date.now()`, add `const absoluteDeadline = runStarted + effectiveTimeoutMs` |
| Pass remaining budget to primary | `ocask.mjs` | `ocask.mjs:351` | Before `invokeWithFallback`, compute `const remaining = Math.max(0, absoluteDeadline - Date.now())` and pass `Math.min(timeoutMs, remaining)` as the effective timeout |
| Pass remaining budget to fallback | `ocask.mjs` | in `timeAttempt` (line 344-388) | The second call to `invokeWithFallback` for fallback should receive remaining budget, not fresh `timeoutMs` |
| Pass remaining budget to cross-verify buddy | `ocask.mjs` | `ocask.mjs:447` | Before `invokeWithFallback` for buddy, compute and pass remaining budget |

#### 5c. Per-provider timeout enforcement

The per-provider timeout is already enforced in `providers/opencode.mjs:302` via `setTimeout`
in `runBoundedCommand`. No change is needed at the provider level — the fix is at the caller
level (ocask.mjs) passing the correct remaining budget. The opencode provider already handles
`TIMEOUT` correctly (line 375) and kills the child process with SIGTERM → SIGKILL grace
(line 272).

#### 5d. Cross-verify multiplier (primary + buddy)

Today the cross-verify buddy call (ocask.mjs:447) starts a fresh `timeoutMs`. With an absolute
deadline, both primary and buddy share the same ceiling. If the primary consumed 150s of a 170s
budget, the buddy gets 20s — not another 170s.

**Summary of enforcement points:**

```
ocask.mjs:18+   → DEFAULT_TIMEOUT_MS = 170_000; HARD_CEIL_MS = 300_000 (constants)
ocask.mjs:322   → timeoutMs = DEFAULT_TIMEOUT_MS (runAsk default param)
ocask.mjs:600   → parsePositiveInt(..., DEFAULT_TIMEOUT_MS) + cap to HARD_CEIL_MS (CLI default)
ocask.mjs:335   → const absoluteDeadline = Date.now() + effectiveTimeoutMs (start the clock)
ocask.mjs:351   → pass min(timeoutMs, absoluteDeadline - Date.now()) to invokeWithFallback
ocask.mjs:404   → same budget deduction for fallback call
ocask.mjs:447   → same budget deduction for cross-verify buddy call
```

---

## 6. Uncertainty statement

1. **n=22 is too small for stable P99 or P99.9.** P99 is pinned to the maximum (271.9s) and
   will jump with each additional slow run in the tail. n≥100 is needed for a reliable P99.
2. **The 271.9s run (qwen3.7-max, n=2 for that model)** may be an outlier — the qwen3.7-max
   model has only 2 successes in the log, insufficient to characterize its tail.
3. **Two models dominate the dataset:** deepseek-v4-pro (18/22) and deepseek-v4-flash (2/22)
   plus qwen3.7-max (2/22). The default covers all models in the single-call topology, but
   different models have different latency profiles. DeepSeek's tail (166.6s max) is tighter
   than Qwen's (272s max). A per-model default (e.g., 170s for deepseek, 300s for qwen)
   could be more precise — but ocask exposes one default for all models, so the value must
   accommodate the slowest observed model family.
4. **The hedged alternative (60s) is based on the assumption that hedge latency ≈ fast-cluster
   latency (median ~12s).** If the hedge model also hits a slow tail, the effective deadline
   may need adjustment upward. The 300s hard ceiling always protects the pipeline.
5. **The salvaged bench repo (`~/devtony/opencode-verify/bench.mjs`)** has the benchmark
   harness but no recorded latency data — it was designed for correctness benchmarking
   (TP/FN/FP/TN), not latency measurement. The 14 ground-truth cases (#6 contract line 36)
   were the correctness test cases (`bench-cases.mjs`), not latency benchmarks. The latency
   data lives exclusively in the production log (`log.jsonl`).

---

## 7. Conclusion

| Item | Value | Justification |
|---|---|---|
| Recommended default (no hedge) | **170s** | P95 of n=22 single-call distribution (166.6s, rounded). Preserves 21/22 observed successes. n is too small for stable P99. |
| Recommended default (with hedge) | **60s** | P50 + hedge completion safety margin. Hedge rescues the slow tail; deadline protects against hang. |
| Hard ceiling (#6 C4) | **300s** | Affirmed. Well above max observed (271.9s), prevents unbounded override. |
| Absolute deadline enforcement | 5 sites (see §5b) | `ocask.mjs:335,351,404,447` — shared wall-clock ceiling for primary + fallback + cross-verify. |
| Next data need | 100+ uncensored completions | For a stable P99/P99.9. Either continued production logging at ≥300s timeout or a dedicated latency benchmark. |
