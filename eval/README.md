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

`eval/run-live.mjs` is present as the harness entrypoint, but this PR only wires the gate and runner contract.

```
RUN_LIVE_EVAL=true node eval/run-live.mjs
```

The runner exits immediately when `RUN_LIVE_EVAL !== "true"` and does not perform any live calls in this phase.

## Budget tracker

Budget is enforced via `eval/budget.mjs`.

- Set cap with `EVAL_BUDGET_CAP` environment variable.
- Hard stop occurs when the cap is exhausted.
- Both `runCaseMatrix` and `runCorpusMatrix` honor budget pressure before new invocations.

## Golden fixtures

`eval/golden/*.json` stores curated real-ish `ocask` outputs used by `eval/golden.test.mjs`.
