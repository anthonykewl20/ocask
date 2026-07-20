// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregate, exactBinomialTail } from './metrics.mjs';

function mkRow(overrides) {
  return {
    case_id: 'case',
    language: 'javascript',
    arm: 'control',
    iteration: 1,
    ground_truth: 'buggy',
    parse_ok: true,
    truncated: false,
    verdict: 'APPROVED',
    raw: 'VERDICT: APPROVED',
    tokens_used: 100,
    comparable: true,
    expected: 'APPROVED',
    invoke_error: null,
    ...overrides,
  };
}

test('exactBinomialTail handles known values', () => {
  const exact = exactBinomialTail(5, 10, 0.5);
  assert.ok(Math.abs(exact - 0.623046875) < 1e-12);

  const tailFromOne = exactBinomialTail(5, 10, 0);
  assert.equal(tailFromOne, 0);
});

test('aggregate computes recall, fp and metrics with arm comparisons', () => {
  const rows = [
    mkRow({ case_id: 'bug-1', arm: 'control', verdict: 'BLOCKED', ground_truth: 'buggy', tokens_used: 100, parse_ok: true, truncated: false }),
    mkRow({ case_id: 'bug-2', arm: 'control', verdict: 'APPROVED', ground_truth: 'buggy', tokens_used: 110, parse_ok: true, truncated: false }),
    mkRow({ case_id: 'clean-1', arm: 'control', verdict: 'APPROVED', ground_truth: 'clean', tokens_used: 90, parse_ok: true, truncated: false }),
    mkRow({ case_id: 'clean-2', arm: 'control', verdict: 'WARNING', ground_truth: 'clean', tokens_used: 80, parse_ok: true, truncated: false }),

    mkRow({ case_id: 'bug-1', arm: 'lens', verdict: 'BLOCKED', ground_truth: 'buggy', tokens_used: 90, parse_ok: true, truncated: false }),
    mkRow({ case_id: 'bug-2', arm: 'lens', verdict: 'BLOCKED', ground_truth: 'buggy', tokens_used: 100, parse_ok: true, truncated: false }),
    mkRow({ case_id: 'clean-1', arm: 'lens', verdict: 'APPROVED', ground_truth: 'clean', tokens_used: 70, parse_ok: true, truncated: false }),
    mkRow({ case_id: 'clean-2', arm: 'lens', verdict: 'APPROVED', ground_truth: 'clean', tokens_used: 120, parse_ok: true, truncated: false }),
  ];

  const out = aggregate(rows);

  assert.equal(out.baseline_arm, 'control');
  assert.equal(out.row_count, 8);
  assert.equal(out.by_arm.control.lenient_recall, 0.5);
  assert.equal(out.by_arm.control.strict_recall, 0.5);
  assert.equal(out.by_arm.control.fp_rate, 0.5);
  assert.equal(out.by_arm.lens.lenient_recall, 1);
  assert.equal(out.by_arm.lens.strict_recall, 1);
  assert.equal(out.by_arm.lens.fp_rate, 0);
  assert.equal(out.comparisons.lens.lenient_recall.delta, 0.5);
  assert.equal(out.comparisons.lens.lenient_recall.significant, false);
  assert.equal(out.guardrails.lens.guardrail_4_no_downgrade, true);
});

test('aggregate computes flip-rate from multi-iteration instability', () => {
  const rows = [
    mkRow({ case_id: 'bug-flip', arm: 'control', iteration: 1, verdict: 'BLOCKED', ground_truth: 'buggy', parse_ok: true, truncated: false }),
    mkRow({ case_id: 'bug-flip', arm: 'control', iteration: 2, verdict: 'WARNING', ground_truth: 'buggy', parse_ok: true, truncated: false }),
    mkRow({ case_id: 'bug-flip', arm: 'control', iteration: 3, verdict: 'APPROVED', ground_truth: 'buggy', parse_ok: true, truncated: false }),
    mkRow({ case_id: 'clean-flip', arm: 'control', iteration: 1, verdict: 'APPROVED', ground_truth: 'clean', parse_ok: true, truncated: false }),
    mkRow({ case_id: 'clean-flip', arm: 'control', iteration: 2, verdict: 'BLOCKED', ground_truth: 'clean', parse_ok: true, truncated: false }),
  ];

  const out = aggregate(rows);

  assert.equal(out.by_case['bug-flip'].control.length, 3);
  assert.equal(out.by_case['clean-flip'].control.length, 2);
  assert.equal(out.by_arm.control.flip_rate, 1);
  assert.equal(out.by_arm.control.flip.flips, 3);
  assert.equal(out.by_arm.control.flip.opportunities, 3);
  assert.equal(out.flip.by_arm.control.flips, 3);
  assert.equal(out.flip.by_arm.control.opportunities, 3);
});

test('aggregate collapses repeat rows to case-level outcomes for recall and FP', () => {
  const rows = [
    mkRow({ case_id: 'buggy-agg', arm: 'control', iteration: 1, verdict: 'APPROVED', ground_truth: 'buggy' }),
    mkRow({ case_id: 'buggy-agg', arm: 'control', iteration: 2, verdict: 'WARNING', ground_truth: 'buggy' }),
    mkRow({ case_id: 'buggy-agg', arm: 'control', iteration: 3, verdict: 'BLOCKED', ground_truth: 'buggy' }),
    mkRow({ case_id: 'clean-agg', arm: 'control', iteration: 1, verdict: 'APPROVED', ground_truth: 'clean' }),
    mkRow({ case_id: 'clean-agg', arm: 'control', iteration: 2, verdict: 'BLOCKED', ground_truth: 'clean' }),
    mkRow({ case_id: 'clean-agg', arm: 'control', iteration: 3, verdict: 'APPROVED', ground_truth: 'clean' }),
  ];

  const out = aggregate(rows);

  assert.equal(out.by_arm.control.row_count, 6);
  assert.equal(out.by_arm.control.buggy_total, 1);
  assert.equal(out.by_arm.control.clean_total, 1);
  assert.equal(out.by_arm.control.lenient_recall, 1);
  assert.equal(out.by_arm.control.fp_rate, 0);
});

const TABLE_DRIVEN_CASES = [
  {
    name: 'panel no-consensus on clean maps to conservative FP',
    rows: [
      mkRow({
        case_id: 'panel-no-consensus-clean',
        arm: 'panel',
        ground_truth: 'clean',
        parse_ok: false,
        truncated: false,
        verdict: null,
        raw: 'PANEL NO-JUDGMENT quorum_failure',
      }),
    ],
    assert: (out) => {
      assert.equal(out.by_arm.panel.clean_total, 1);
      assert.equal(out.by_arm.panel.clean_false_positives, 1);
      assert.equal(out.by_arm.panel.fp_rate, 1);
      assert.equal(out.by_arm.panel.abstained_rows, 0);
    },
  },
  {
    name: 'solo abstention on clean is not FP but is counted in abstention_rate',
    rows: [
      mkRow({
        case_id: 'clean-abstain',
        arm: 'control',
        ground_truth: 'clean',
        parse_ok: false,
        truncated: false,
        verdict: null,
        raw: 'unparseable output blob',
        tokens_used: null,
      }),
    ],
    assert: (out) => {
      assert.equal(out.by_arm.control.clean_false_positives, 0);
      assert.equal(out.by_arm.control.fp_rate, 0);
      assert.equal(out.by_arm.control.abstained_rows, 1);
      assert.equal(out.by_arm.control.abstention_rate, 1);
      assert.equal(out.abstention_rate, 1);
    },
  },
  {
    name: 'truncated clean row maps to FP',
    rows: [
      mkRow({
        case_id: 'clean-truncated',
        arm: 'control',
        ground_truth: 'clean',
        parse_ok: false,
        truncated: true,
        verdict: null,
        raw: '...[truncated]',
      }),
    ],
    assert: (out) => {
      assert.equal(out.by_arm.control.fp_rate, 1);
      assert.equal(out.by_arm.control.clean_false_positives, 1);
      assert.equal(out.by_arm.control.abstained_rows, 0);
    },
  },
  {
    name: 'buggy abstention is not caught and lowers recall',
    rows: [
      mkRow({
        case_id: 'buggy-abstain',
        arm: 'control',
        ground_truth: 'buggy',
        parse_ok: false,
        truncated: false,
        verdict: null,
        raw: 'unparseable output blob',
      }),
    ],
    assert: (out) => {
      assert.equal(out.by_arm.control.lenient_recall, 0);
      assert.equal(out.by_arm.control.abstained_rows, 1);
      assert.equal(out.by_arm.control.abstention_rate, 1);
    },
  },
  {
    name: 'null to blocked sequence creates flip opportunities from abstentions',
    rows: [
      mkRow({
        case_id: 'abstain-to-blocked',
        arm: 'control',
        ground_truth: 'buggy',
        iteration: 1,
        parse_ok: false,
        truncated: false,
        verdict: null,
        raw: 'non-parseable',
      }),
      mkRow({
        case_id: 'abstain-to-blocked',
        arm: 'control',
        ground_truth: 'buggy',
        iteration: 2,
        parse_ok: false,
        truncated: false,
        verdict: null,
        raw: 'still non-parseable',
      }),
      mkRow({
        case_id: 'abstain-to-blocked',
        arm: 'control',
        ground_truth: 'buggy',
        iteration: 3,
        parse_ok: true,
        truncated: false,
        verdict: 'BLOCKED',
      }),
    ],
    assert: (out) => {
      assert.equal(out.by_arm.control.flip.flips, 1);
      assert.equal(out.by_arm.control.flip.opportunities, 2);
      assert.equal(out.by_arm.control.flip.rate, 0.5);
      assert.equal(out.by_arm.control.lenient_recall, 0);
      assert.equal(out.by_arm.control.abstained_rows, 2);
    },
  },
  {
    name: 'all-null tokens produce null token aggregates and TER',
    rows: [
      mkRow({
        case_id: 'no-tokens-buggy',
        arm: 'control',
        ground_truth: 'buggy',
        verdict: 'BLOCKED',
        tokens_used: null,
      }),
      mkRow({
        case_id: 'no-tokens-clean',
        arm: 'control',
        ground_truth: 'clean',
        verdict: 'APPROVED',
        tokens_used: null,
      }),
    ],
    assert: (out) => {
      assert.equal(out.by_arm.control.tokens_total, null);
      assert.equal(out.by_arm.control.tokens_per_case, null);
      assert.equal(out.by_arm.control.tokens_case_count, 0);
      assert.equal(out.flip.total.rate >= 0, true);
    },
  },
  {
    name: 'token aggregates remain numeric when token rows are present',
    rows: [
      mkRow({
        case_id: 'has-token-buggy',
        arm: 'control',
        ground_truth: 'buggy',
        verdict: 'BLOCKED',
        tokens_used: 100,
      }),
      mkRow({
        case_id: 'has-token-clean',
        arm: 'control',
        ground_truth: 'clean',
        verdict: 'APPROVED',
        tokens_used: 300,
      }),
    ],
    assert: (out) => {
      assert.equal(out.by_arm.control.tokens_total, 400);
      assert.equal(out.by_arm.control.tokens_per_case, 200);
      assert.equal(out.by_arm.control.tokens_case_count, 2);
    },
  },
];

for (const testCase of TABLE_DRIVEN_CASES) {
  test(testCase.name, () => {
    const out = aggregate(testCase.rows);
    testCase.assert(out);
  });
}

test('aggregate passes through optional total cost', () => {
  const out = aggregate(
    [
      mkRow({
        case_id: 'cost-row',
        arm: 'control',
        ground_truth: 'buggy',
      }),
    ],
    { cost_usd: '12.50' },
  );
  assert.equal(out.cost_usd, 12.5);
});
