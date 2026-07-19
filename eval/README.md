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
- `EVAL_BUDGET_CAP` sets the USD cap (default `1`).
- `EVAL_LIVE_CONCURRENCY` sets concurrency (default `5`).

Example:

```
EVAL_BUDGET_CAP=1 EVAL_LIVE_CONCURRENCY=5 RUN_LIVE_EVAL=true node eval/run-live.mjs
```

On success, this writes:
- `eval/baseline/run-live-results.json` (full run payload)
- `eval/baseline/frozen-baseline.json` (when completion ratio is `>= 0.8`)

## Budget tracker

Budget is enforced via `eval/budget.mjs`.

- Set cap with `EVAL_BUDGET_CAP` environment variable.
- Hard stop occurs when the cap is exhausted.
- Both `runCaseMatrix` and `runCorpusMatrix` honor budget pressure before new invocations.

## Golden fixtures

`eval/golden/*.json` stores curated real-ish `ocask` outputs used by `eval/golden.test.mjs`.
