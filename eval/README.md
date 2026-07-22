# Offline ocask Eval Harness (Phase 1)

This directory contains the offline `ocask` review eval harness used for arm and metric validation in CI. It intentionally stays out of `install.sh`.

## Matrix and iterations

- `control` arm: `deepseek-v4-pro` with lens `general`.
- `lens` arm: `deepseek-v4-pro` with lens `code-review`.
- `panel` arm: `deepseek-v4-pro` with `--panel` mode and `general` lens.

Every case is run through **3 arms × 3 iterations** with an injectable invocation seam.

## Running tests

```
node --test eval/*.test.mjs
```

## Running the live runner (gated)

`eval/run-live.mjs` is the gated live runner entrypoint.

```
RUN_LIVE_EVAL=true node eval/run-live.mjs
```

The runner exits immediately when `RUN_LIVE_EVAL !== "true"` and does not perform any live calls.

### Live knobs

- `RUN_LIVE_EVAL=true` is required to run live invocations.
- `EVAL_LIVE_CAP_USD` sets the live spend ceiling in USD (default `1`).
- `EVAL_LIVE_CONCURRENCY` sets concurrency (default `5`).
- `EVAL_OUTPUT_MODE` selects the verdict contract: `json` (default) or `text`.
- `EVAL_OCASK_PATH` selects the `ocask.mjs` checkout to measure (default: this repository).
- `EVAL_FREEZE_BASELINE=true` explicitly opts into replacing the frozen baseline after a
  qualifying run. Omit it for normal runs.

Example:

```
EVAL_LIVE_CAP_USD=1 EVAL_LIVE_CONCURRENCY=5 EVAL_OUTPUT_MODE=text \
  RUN_LIVE_EVAL=true node eval/run-live.mjs
```

Every completed run writes `eval/baseline/run-live-results.json`. A normal run never writes
`eval/baseline/frozen-baseline.json`, even when its completion ratio is high enough to freeze.
Replacing that reference additionally requires `EVAL_FREEZE_BASELINE=true` and a case
completion ratio of at least `0.8`.

Frozen payloads record `output_mode` and a structured `system_under_test` identity resolved
from the checkout containing `EVAL_OCASK_PATH`: executable path, branch (or detached HEAD),
commit, and dirty state. If git identity cannot be resolved, the payload records
`resolution: "unresolved"` with null ref/commit fields instead of claiming a false ref.

## Budget tracker

Offline invocation budgets are enforced via `eval/budget.mjs`; they are separate from the
live runner's USD ceiling.

- Pass a `createBudgetTracker({ cap })` tracker to the offline matrix API (default cap `5000`).
- Hard stop occurs when the cap is exhausted.
- Both `runCaseMatrix` and `runCorpusMatrix` honor budget pressure before new invocations.

## Golden fixtures

`eval/golden/*.json` stores curated real-ish `ocask` outputs used by `eval/golden.test.mjs`.

## Output mode, and what it does not yet give you

`EVAL_OUTPUT_MODE` selects `json` (default) or `text`, and the chosen mode is recorded in any
frozen baseline so a JSON-mode baseline can never again be mistaken for a general one.

**Text mode is plumbing only until #87 lands.** The scoring path — `eval/arm.mjs` and
`eval/metrics.mjs` — reads verdicts through `parseVerdict` in `eval/parse.mjs`, which uses an
unanchored substring match. The product uses a whole-line rule where every occurrence must agree
(`ocask.mjs`, `resolveTextVerdict`). Those disagree on real replies: a mid-sentence mention scores
as a verdict here and as nothing in the product, and a contradictory pair scores as the first
verdict here and is rejected outright by the product.

So a text-mode run today would execute the right contract and then grade it by the wrong rule. The
default stays `json` for that reason. #87 makes the harness and the product answer that question
the same way; treat text-mode numbers as untrustworthy until it does.
