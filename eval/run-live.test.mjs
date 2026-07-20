// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBudgetTracker } from './budget.mjs';
import { runLive, REFUSAL_MESSAGE } from './run-live.mjs';

test('runLive refuses to start when budget is already exhausted', async () => {
  const budget = createBudgetTracker({ cap: 0 });
  await assert.rejects(
    async () => runLive({
      budget,
      env: { RUN_LIVE_EVAL: 'true' },
    }),
    (error) => error instanceof Error && error.message === REFUSAL_MESSAGE,
  );
});
