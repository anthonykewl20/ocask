// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBudgetTracker } from './budget.mjs';
import {
  buildFrozenBaselinePayload,
  liveInvoke,
  runLiveMatrix,
  runLive,
  REFUSAL_MESSAGE,
} from './run-live.mjs';
import { freezeBaselineFromCorpus } from './matrix.mjs';

const BASE_REQUEST = {
  arm: 'control',
  case_id: 'case-live',
  model: 'deepseek-v4-pro',
  lens: 'general',
  panel: false,
  diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new',
  spec: 'Validate live invocation behavior.',
  language: 'javascript',
};

const CASE_RECORD = {
  case_id: 'case-live',
  language: 'javascript',
  diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new',
  spec: 'Validate matrix behavior.',
  ground_truth: 'buggy',
  expected: 'BLOCKED',
};

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

test('runLiveMatrix is table tested for liveInvoke argument construction', async () => {
  const argCases = [
    { name: 'control', arm: 'control', lens: 'general', requiredFlag: '--lens', requiredValue: 'general' },
    { name: 'lens', arm: 'lens', lens: 'code-review', requiredFlag: '--lens', requiredValue: 'code-review' },
    { name: 'panel', arm: 'panel', lens: 'general', requiredFlag: '--panel' },
  ];

  for (const argCase of argCases) {
    const request = {
      ...BASE_REQUEST,
      arm: argCase.arm,
      lens: argCase.lens,
      panel: argCase.arm === 'panel',
      model: 'deepseek-v4-pro',
    };
    let capturedArgs = null;
    const spawnImpl = (_command, args) => {
      capturedArgs = args;
      return {
        stdout: JSON.stringify({ verdict: 'BLOCKED' }),
        exitCode: 0,
      };
    };

    await liveInvoke(request, { ocaskPath: '/tmp/ocask.mjs', spawnImpl });
    assert.equal(capturedArgs?.includes('--model'), true);
    const modelIndex = capturedArgs?.indexOf('--model') ?? -1;
    assert.equal(modelIndex >= 0, true);
    assert.equal(capturedArgs?.[modelIndex + 1], request.model);
    assert.equal(capturedArgs?.includes('--task'), true);
    assert.equal(capturedArgs?.includes('--context'), true);
    assert.equal(capturedArgs?.includes('--require-verdict'), true);
    assert.equal(capturedArgs?.includes('--json'), true);
    assert.equal(capturedArgs?.includes('--temperature'), true);
    assert.equal(capturedArgs?.[capturedArgs.indexOf('--temperature') + 1], '0');
    assert.equal(capturedArgs?.includes('--timeout-ms'), true);
    assert.equal(capturedArgs?.[capturedArgs.indexOf('--timeout-ms') + 1], '900000');
    assert.equal(capturedArgs?.includes(argCase.requiredFlag), true);
    if (argCase.requiredValue) {
      assert.equal(capturedArgs?.[capturedArgs.indexOf(argCase.requiredFlag) + 1], argCase.requiredValue);
    }
    if (argCase.arm === 'panel') {
      assert.equal(capturedArgs?.includes('--lens'), false);
    } else {
      assert.equal(capturedArgs?.includes('--lens'), true);
    }
  }
});

test('liveInvoke maps panel members and attempts metadata', async () => {
  const spawnImpl = () => ({
    stdout: JSON.stringify({
      verdict: 'APPROVED',
      attempts: [{ model: 'deepseek-v4-pro' }],
      members: [
        { model: 'deepseek-v4-pro', verdict: 'BLOCKED', output_preview: 'primary block' },
        { model: 'qwen3.7-plus', verdict: 'APPROVED', output_preview: 'consensus pass' },
      ],
    }),
    exitCode: 0,
  });

  const out = await liveInvoke({
    ...BASE_REQUEST,
    arm: 'panel',
    panel: true,
  }, {
    ocaskPath: '/tmp/ocask.mjs',
    spawnImpl,
  });

  assert.equal(out.panel_members.length, 2);
  assert.equal(out.panel_members[0].model, 'deepseek-v4-pro');
  assert.equal(out.panel_members[0].family, 'deepseek');
  assert.equal(out.panel_members[0].output, JSON.stringify({ verdict: 'BLOCKED', output: 'primary block' }));
  assert.equal(out.panel_members[1].model, 'qwen3.7-plus');
  assert.equal(out.panel_members[1].family, 'qwen');
  assert.equal(out.panel_members[1].output, JSON.stringify({ verdict: 'APPROVED', output: 'consensus pass' }));
  assert.equal(out.metadata.attempts.length, 1);
  assert.equal(out.metadata.exit_code, 0);
});

test('liveInvoke parses JSON payload and preserves parsed attempts', async () => {
  const spawnImpl = () => ({
    stdout: JSON.stringify({
      verdict: 'BLOCKED',
      attempts: [{ phase: 'verdict' }],
    }),
    exitCode: 2,
  });

  const out = await liveInvoke({
    ...BASE_REQUEST,
    arm: 'control',
    lens: 'general',
    panel: false,
  }, {
    ocaskPath: '/tmp/ocask.mjs',
    spawnImpl,
  });

  assert.equal(JSON.parse(out.output).verdict, 'BLOCKED');
  assert.deepEqual(out.metadata.attempts, [{ phase: 'verdict' }]);
  assert.equal(out.metadata.exit_code, 2);
});

test('liveInvoke keeps raw output when JSON parsing fails', async () => {
  const rawOutput = 'VERDICT: BLOCKED\nReview complete.';
  const out = await liveInvoke({
    ...BASE_REQUEST,
    arm: 'control',
    lens: 'general',
    panel: false,
  }, {
    ocaskPath: '/tmp/ocask.mjs',
    spawnImpl: () => ({
      stdout: rawOutput,
      exitCode: 0,
    }),
  });

  assert.equal(out.output, rawOutput);
  assert.equal(out.panel_members.length, 0);
  assert.deepEqual(out.metadata.attempts, [{}]);
  assert.equal(out.metadata.exit_code, 0);
});

test('runLiveMatrix computes aggregate output for a full matrix pass', async () => {
  const out = await runLiveMatrix([
    { ...CASE_RECORD, case_id: 'case-a' },
    { ...CASE_RECORD, case_id: 'case-b' },
  ], {
    invoke: async () => ({ output: 'VERDICT: BLOCKED\n' }),
    capUsd: 10,
    costSnapshotFn: async () => 0,
    concurrency: 2,
  });

  assert.equal(out.status, 'COMPLETED');
  assert.equal(out.total_calls, 18);
  assert.equal(out.can_freeze_baseline, true);
  assert.equal(out.baseline !== null, true);
  assert.equal(typeof out.aggregate?.by_arm?.control, 'object');
  assert.equal(out.completion_ratio >= 0.8, true);
});

test('buildFrozenBaselinePayload emits canonical frozen schema', () => {
  const frozen = buildFrozenBaselinePayload({
    case_count: 2,
    iterations: 3,
    completion_ratio: 0.75,
    total_calls: 18,
    spent_usd: 0.12,
    aggregate: {
      by_arm: {
        control: {
          lenient_recall: 0.5,
          strict_recall: 0.4,
          fp_rate: 0.1,
          abstention_rate: 0.2,
          flip_rate: 0.15,
          blocked_rate: 0.45,
          tokens_per_case: 120,
          ter: 0.25,
        },
        lens: {
          lenient_recall: 0.75,
          strict_recall: 0.75,
          fp_rate: 0.2,
          abstention_rate: 0.05,
          flip_rate: 0.12,
          blocked_rate: 0.35,
          tokens_per_case: 130,
          ter: 0.5,
        },
      },
      comparisons: {
        lens: {
          lenient_recall: {},
          fp_rate: {},
          blocked_rate: {},
          strict_recall: {},
          tokens_per_case: {},
          ter: 0.5,
        },
      },
    },
  }, {
    capUsd: 1,
    concurrency: 5,
  });

  assert.equal(frozen.frozen_at.length, 10);
  assert.equal(frozen.phase, 'T08');
  assert.equal(frozen.system_under_test, 'ocask.mjs@origin/main');
  assert.equal(typeof frozen.frozen_at, 'string');
  assert.deepEqual(Object.keys(frozen).sort(), [
    'frozen_at',
    'phase',
    'system_under_test',
    'run',
    'per_arm',
    'comparisons_vs_control',
    'panel_vs_best_member',
    'notes',
  ].sort());
  assert.equal(frozen.run.cases, 2);
  assert.deepEqual(frozen.run.arms, ['control', 'lens', 'panel']);
  assert.equal(frozen.run.iterations, 3);
  assert.equal(frozen.run.completion_ratio, 0.75);
  assert.equal(frozen.run.total_calls, 18);
  assert.equal(frozen.run.spent_usd, 0.12);
  assert.equal(frozen.run.cap_usd, 1);
  assert.equal(frozen.run.concurrency, 5);
  assert.deepEqual(frozen.per_arm.control, {
    lenient_recall: 0.5,
    strict_recall: 0.4,
    fp_rate: 0.1,
    abstention_rate: 0.2,
    flip_rate: 0.15,
    blocked_rate: 0.45,
    tokens_per_case: 120,
    ter: null,
  });
  assert.deepEqual(frozen.per_arm.lens, {
    lenient_recall: 0.75,
    strict_recall: 0.75,
    fp_rate: 0.2,
    abstention_rate: 0.05,
    flip_rate: 0.12,
    blocked_rate: 0.35,
    tokens_per_case: 130,
    ter: 0.5,
  });
  assert.equal(typeof frozen.comparisons_vs_control, 'object');
  assert.equal(typeof frozen.notes, 'string');
});

test('runLive fails fast when a USD cap is enabled without a cost snapshot seam', async () => {
  await assert.rejects(
    async () => runLive({
      budget: createBudgetTracker({ cap: 1 }),
      env: { RUN_LIVE_EVAL: 'true' },
      invoke: async () => ({ output: 'VERDICT: BLOCKED' }),
      capUsd: 1,
    }),
    (error) => error instanceof Error
      && error.message.includes('cost snapshot seam'),
  );
});

test('runLiveMatrix hard-aborts when cost cap is crossed at attempt-block boundary', async () => {
  let seen = 0;
  const costSnapshotFn = async () => {
    seen += 1;
    return seen === 1 ? 0.7 : 0.7;
  };

  const out = await runLiveMatrix([
    { ...CASE_RECORD, case_id: 'case-a' },
    { ...CASE_RECORD, case_id: 'case-b' },
    { ...CASE_RECORD, case_id: 'case-c' },
  ], {
    invoke: async () => ({ output: 'VERDICT: BLOCKED\n' }),
    capUsd: 0.5,
    costSnapshotFn,
    concurrency: 5,
  });

  assert.equal(out.status, 'FAILED');
  assert.equal(out.total_calls, 15);
  assert.equal(out.completion_ratio < 0.8, true);
  assert.equal(out.case_completion_ratio < 0.8, true);
  assert.equal(out.can_freeze_baseline, false);
  assert.equal(out.baseline, null);
  assert.equal(freezeBaselineFromCorpus(out.case_completion_ratio, out.rows, {
    requiredCaseCompletion: 0.8,
  }), null);
});

test('runLive returns SKIPPED when RUN_LIVE_EVAL is not enabled', async () => {
  const out = await runLive({
    budget: createBudgetTracker({ cap: 1 }),
    env: { RUN_LIVE_EVAL: 'false' },
  });

  assert.equal(out.status, 'SKIPPED');
  assert.equal(out.reason.includes('Offline harness is enabled by default'), true);
});
