// SPDX-License-Identifier: Apache-2.0
// Matrix orchestration for evaluation arm × iteration execution.

import { createBudgetTracker, hasBudget } from './budget.mjs';
import { ARM_LABELS, ARM_CONFIG, validateControlLensAgreement, runOcaskArm } from './arm.mjs';
import { aggregate } from './metrics.mjs';

const DEFAULT_ITERATIONS = 3;
const DEFAULT_BACKOFF_MS = 25;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeCase(caseRecord, index) {
  return {
    case_id: String(caseRecord.case_id ?? caseRecord.id ?? index ?? ''),
    language: caseRecord.language,
    diff: caseRecord.diff,
    spec: caseRecord.spec,
    ground_truth: caseRecord.ground_truth,
    expected: caseRecord.expected,
  };
}

function completionRate(completedRows, expectedRows) {
  if (expectedRows <= 0) return 0;
  return completedRows / expectedRows;
}

export function freezeBaselineFromCorpus(caseCompletionRatio, rows, {
  requiredCaseCompletion = 0.8,
  cost_usd,
} = {}) {
  if (caseCompletionRatio < requiredCaseCompletion) return null;
  return aggregate(rows, { cost_usd });
}

function buildRowWithTimeoutMark(row, hadTimeoutRetry) {
  if (!hadTimeoutRetry) return row;
  return {
    ...row,
    comparable: false,
    invoke_error: {
      ...(row.invoke_error || {}),
      timeout_retry: true,
    },
  };
}

function applyPanelFallback(row) {
  if (!row || row.arm !== 'panel') return row;
  const looksLikeNoConsensus = row.ground_truth !== null
    && row.parse_ok !== true
    && (() => {
      const text = String(row.raw || '').toLowerCase();
      return text.includes('no-judgment')
        || text.includes('panel no-judgment')
        || text.includes('quorum failure')
        || text.includes('quorum_failure');
    })();

  if (!looksLikeNoConsensus) return row;
  if (row.ground_truth === 'clean') {
    return {
      ...row,
      verdict: 'WARNING',
      parse_ok: true,
      truncated: false,
      comparable: false,
      parse_outcome: 'PANEL_NO_CONSENSUS_FP',
    };
  }

  return {
    ...row,
    comparable: false,
    parse_outcome: 'PANEL_NO_CONSENSUS_MISS',
  };
}

function normalizeArmList(armOrder) {
  if (!armOrder || !armOrder.length) return ARM_LABELS;
  const deduped = [...new Set(armOrder)];
  for (const arm of deduped) {
    if (!ARM_CONFIG[arm]) throw new Error(`Unknown arm: ${arm}`);
  }
  return deduped;
}

async function runSingleArmIteration(caseRecord, arm, {
  iteration,
  invoke,
  caseIndex,
  case_id,
  budget = null,
  retries = 1,
  backoffMs = DEFAULT_BACKOFF_MS,
}) {
  let hadTimeout = false;
  let lastRow = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      if (budget && !hasBudget({ budget, count: 1 })) {
        return {
          row: lastRow ? buildRowWithTimeoutMark(lastRow, true) : null,
        };
      }
      await delay(attempt * backoffMs);
      hadTimeout = true;
    }

    if (budget) {
      budget.consume(1);
    }

    const row = await runOcaskArm(caseRecord, arm, {
      invoke,
      caseIndex,
      case_id,
      iteration,
      extra: { attempt },
    });
    lastRow = row;

    const timedOut = row?.invoke_error?.code === 'TIMEOUT';
    if (!timedOut) {
      return {
        row: buildRowWithTimeoutMark(row, hadTimeout),
      };
    }

    if (attempt >= retries) {
      return {
        row: buildRowWithTimeoutMark(row, true),
      };
    }
  }

  return {
    row: lastRow ? buildRowWithTimeoutMark(lastRow, true) : null,
  };
}

export async function runCaseMatrix(caseRecord, {
  invoke,
  iterations = DEFAULT_ITERATIONS,
  arms = ARM_LABELS,
  budget = null,
  retries = 1,
  backoffMs = DEFAULT_BACKOFF_MS,
}) {
  if (typeof invoke !== 'function') {
    throw new TypeError('runCaseMatrix requires an invoke function');
  }

  validateControlLensAgreement();

  const armOrder = normalizeArmList(arms);
  const normalizedCase = normalizeCase(caseRecord);
  const cid = normalizedCase.case_id;
  const rows = [];

  for (const arm of armOrder) {
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      if (budget && !hasBudget({ budget, count: 1 })) {
        return {
          case_id: cid,
          rows,
          status: 'FAILED',
          arm_count: armOrder.length,
          iterations,
          expected_rows: armOrder.length * iterations,
          completed_rows: rows.length,
          completion_ratio: completionRate(rows.length, armOrder.length * iterations),
          completed: rows.length === armOrder.length * iterations,
        };
      }

      const result = await runSingleArmIteration(normalizedCase, arm, {
        iteration,
        invoke,
        caseIndex: null,
        case_id: cid,
        retries,
        backoffMs,
        budget,
      });
      if (result.row) {
        rows.push({ ...applyPanelFallback({ ...result.row, arm })});
      }
    }
  }

  return {
    case_id: cid,
    rows,
    status: 'COMPLETED',
    arm_count: armOrder.length,
    iterations,
    expected_rows: armOrder.length * iterations,
    completed_rows: rows.length,
    completion_ratio: completionRate(rows.length, armOrder.length * iterations),
    completed: rows.length === armOrder.length * iterations,
  };
}

export async function runCorpusMatrix(cases, {
  invoke,
  iterations = DEFAULT_ITERATIONS,
  arms = ARM_LABELS,
  budget = createBudgetTracker(),
  retries = 1,
  backoffMs = DEFAULT_BACKOFF_MS,
  requiredCaseCompletion = 0.8,
  cost_usd = null,
} = {}) {
  if (!Array.isArray(cases)) {
    throw new TypeError('runCorpusMatrix requires a case array');
  }

  validateControlLensAgreement();

  const armOrder = normalizeArmList(arms);
  const allRows = [];
  const caseResults = [];

  for (let index = 0; index < cases.length; index += 1) {
    const caseRecord = cases[index];

    const caseResult = await runCaseMatrix(caseRecord, {
      invoke,
      iterations,
      arms: armOrder,
      budget,
      retries,
      backoffMs,
    });

    allRows.push(...caseResult.rows);
    caseResults.push(caseResult);

    if (caseResult.status !== 'COMPLETED') break;
  }

  const completedCaseCount = caseResults.filter((caseResult) => caseResult.completed).length;
  const caseCompletion = caseCountRatio(caseResults, cases.length);
  const expectedRows = cases.length * armOrder.length * iterations;
  const completion = completionRate(allRows.length, expectedRows);
  const baseline = freezeBaselineFromCorpus(caseCompletion, allRows, {
    requiredCaseCompletion,
    cost_usd,
  });

  return {
    status: caseCompletion >= requiredCaseCompletion ? 'COMPLETED' : 'FAILED',
    can_freeze_baseline: caseCompletion >= requiredCaseCompletion && baseline !== null,
    cost_usd,
    baseline,
    rows: allRows,
    case_results: caseResults,
    budget: budget.snapshot?.(),
    arm_count: armOrder.length,
    iterations,
    case_count: cases.length,
    completed_case_count: completedCaseCount,
    case_completion_ratio: caseCompletion,
    completion_ratio: completion,
    case_failure: caseCompletion < requiredCaseCompletion,
  };

}

function caseCountRatio(caseResults, total) {
  if (!total) return 0;
  const completed = caseResults.filter((result) => result.completed).length;
  return completed / total;
}
