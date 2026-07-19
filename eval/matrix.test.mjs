// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBudgetTracker, hasBudget } from './budget.mjs';
import { freezeBaselineFromCorpus, runCaseMatrix, runCorpusMatrix } from './matrix.mjs';

const CASE = {
  case_id: 'case-matrix',
  language: 'javascript',
  diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new',
  spec: 'Exercise matrix path and budget handling.',
  ground_truth: 'buggy',
  expected: 'BLOCKED',
};

test('runCaseMatrix executes 3x3 rows for default arm set', async () => {
  const invoke = async () => ({ output: 'VERDICT: BLOCKED\nReview complete.' });
  const result = await runCaseMatrix(CASE, { invoke });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.rows.length, 9);
  assert.equal(result.completed, true);
  assert.equal(result.expected_rows, 9);
  assert.equal(result.completion_ratio, 1);
});

test('runCorpusMatrix forwards optional cost metadata', async () => {
  const out = await runCorpusMatrix([CASE], {
    invoke: async () => ({ output: 'VERDICT: BLOCKED\nReview complete.' }),
    cost_usd: 42,
  });

  assert.equal(out.cost_usd, 42);
  assert.equal(out.baseline?.cost_usd, 42);
});

test('runCorpusMatrix reports failure when completion drops below budget envelope', async () => {
  const budget = createBudgetTracker({ cap: 5 });
  const invoke = async () => ({ output: 'VERDICT: BLOCKED\nReview complete.' });

  const out = await runCorpusMatrix([CASE, CASE], {
    invoke,
    budget,
    arms: ['control'],
    retries: 0,
  });

  assert.equal(out.status, 'FAILED');
  assert.equal(out.rows.length, 5);
  assert.equal(out.case_results[0].rows.length, 3);
  assert.equal(out.case_results[0].status, 'COMPLETED');
  assert.equal(out.case_results[1].status, 'FAILED');
  assert.equal(out.case_results[1].rows.length, 2);
  assert.equal(out.case_results[1].completed_rows, 2);
  assert.equal(out.case_count, 2);
  assert.equal(out.case_completion_ratio < 0.8, true);
  assert.equal(hasBudget({ budget, count: 1 }), false);
});

test('runCorpusMatrix does not allow baseline freezing below completion gate', async () => {
  const budget = createBudgetTracker({ cap: 5 });
  const out = await runCorpusMatrix([CASE, CASE], {
    invoke: async () => ({ output: 'VERDICT: BLOCKED\nReview complete.' }),
    budget,
    arms: ['control'],
    retries: 0,
  });

  assert.equal(out.status, 'FAILED');
  assert.equal(out.can_freeze_baseline, false);
  assert.equal(out.baseline, null);
  assert.equal(
    freezeBaselineFromCorpus(out.case_completion_ratio, out.rows, { requiredCaseCompletion: 0.8 }),
    null,
  );
});

test('runSingle iteration marks timeout retries as non-comparable', async () => {
  const state = new Map();
  const invoke = async (request) => {
    const key = `${request.arm}:${request.iteration}:${state.get(`${request.arm}:${request.iteration}`) || 0}`;
    const prior = state.get(`${request.arm}:${request.iteration}`) || 0;
    state.set(`${request.arm}:${request.iteration}`, prior + 1);

    if (request.arm === 'control' && request.iteration === 1 && prior === 0) {
      const error = new Error('timeout');
      error.code = 'TIMEOUT';
      throw error;
    }

    return {
      output: 'VERDICT: APPROVED\nRetry handled. ',
    };
  };

  const out = await runCaseMatrix(CASE, {
    invoke,
    arms: ['control'],
    iterations: 1,
    retries: 1,
  });

  assert.equal(out.rows.length, 1);
  const row = out.rows[0];
  assert.equal(row.iteration, 1);
  assert.equal(row.parse_ok, true);
  assert.equal(row.comparable, false);
  assert.equal(Boolean(row.invoke_error), true);
  assert.equal(row.invoke_error?.timeout_retry, true);
});

test('runCaseMatrix never exceeds cap when retries are requested', async () => {
  const state = new Map();
  const invoke = async (request) => {
    const prior = state.get(request.iteration) ?? 0;
    state.set(request.iteration, prior + 1);

    const error = new Error('timeout');
    error.code = 'TIMEOUT';
    throw error;
  };

  const out = await runCaseMatrix(CASE, {
    invoke,
    arms: ['control'],
    iterations: 3,
    retries: 1,
    budget: createBudgetTracker({ cap: 1 }),
  });

  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].iteration, 1);
  assert.equal(out.completed, false);
  assert.equal(out.completion_ratio, 1 / 3);
  assert.equal(out.status, 'FAILED');
  assert.equal(state.get(1), 1);
});

test('runCaseMatrix converts panel no-consensus clean outcomes to conservative FP', async () => {
  const invoke = async () => ({ output: 'PANEL NO-JUDGMENT\nquorum_failure' });
  const out = await runCaseMatrix({
    ...CASE,
    case_id: 'panel-no-consensus-clean',
    ground_truth: 'clean',
    expected: 'APPROVED',
  }, {
    invoke,
    arms: ['panel'],
    iterations: 1,
    retries: 0,
  });

  assert.equal(out.status, 'COMPLETED');
  assert.equal(out.rows.length, 1);
  const row = out.rows[0];
  assert.equal(row.arm, 'panel');
  assert.equal(row.verdict, 'WARNING');
  assert.equal(row.parse_ok, true);
  assert.equal(row.comparable, false);
});
