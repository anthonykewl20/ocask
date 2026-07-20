// SPDX-License-Identifier: Apache-2.0
// Aggregate recorded ocask eval rows into numeric metrics and guardrails.

import { parseVerdict } from './parse.mjs';

const VALID_VERDICTS = Object.freeze(['APPROVED', 'WARNING', 'BLOCKED']);
const BASELINE_ARM = 'control';
const SIGNIFICANCE_ALPHA = 0.15;
const MIN_RECALL_GAIN = 2;
const RECALL_CEILING_RECALL = 0.8;
const LENIENT_OUTCOMES = new Set(['BLOCKED', 'WARNING']);
const ABSTAINED_OUTCOME = 'ABSTAINED';
const PANEL_NO_CONSENSUS_MARKERS = Object.freeze([
  'no-judgment',
  'panel no-judgment',
  'quorum failure',
  'quorum_failure',
]);

function requiredConsensus(iterationCount) {
  return iterationCount <= 1 ? 1 : 2;
}

function normalizeCost(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isPanelArm(row) {
  return row?.arm === 'panel' || row?.panel === true;
}

function isPanelNoConsensus(row) {
  if (!isPanelArm(row)) return false;

  const parseOutcome = row?.parse_outcome;
  if (typeof parseOutcome === 'string' && parseOutcome.toLowerCase().includes('panel_no_consensus')) {
    return true;
  }

  const lowerRaw = typeof row?.raw === 'string' ? row.raw.toLowerCase() : '';
  return PANEL_NO_CONSENSUS_MARKERS.some((marker) => lowerRaw.includes(marker));
}

function outcomeDetail(row) {
  if (row?.truncated) return row?.ground_truth === 'clean' ? 'WARNING' : 'TRUNCATED';
  const verdict = normalizeVerdict(row?.verdict);
  if (verdict) return verdict;
  if (isPanelNoConsensus(row)) return row?.ground_truth === 'clean' ? 'WARNING' : 'MISS';
  return ABSTAINED_OUTCOME;
}

function shortOutcomeFromDetail(detail, groundTruth) {
  if (groundTruth === 'buggy') {
    return (detail === 'BLOCKED' || detail === 'WARNING') ? 'caught' : 'missed';
  }
  if (groundTruth === 'clean') {
    return detail === 'APPROVED' || detail === ABSTAINED_OUTCOME ? 'tn' : 'fp';
  }
  return null;
}

function toFinite(value) {
  return Number.isFinite(value) ? value : null;
}

function normalizeVerdict(raw) {
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim().toUpperCase();
  return VALID_VERDICTS.includes(candidate) ? candidate : null;
}

function normalizeGroundTruth(raw) {
  return raw === 'buggy' || raw === 'clean' ? raw : null;
}

function normalizeRow(row, index) {
  const groundTruth = normalizeGroundTruth(row?.ground_truth);
  const detail = outcomeDetail({ ...row, ground_truth: groundTruth });
  const shortOutcome = shortOutcomeFromDetail(detail, groundTruth);
  return {
    case_id: String(row?.case_id ?? row?.id ?? index ?? ''),
    language: typeof row?.language === 'string' ? row.language : 'javascript',
    arm: String(row?.arm ?? ''),
    iteration: Number.isInteger(row?.iteration) ? row.iteration : null,
    ground_truth: groundTruth,
    verdict: normalizeVerdict(row?.verdict),
    parse_ok: row?.parse_ok === true,
    truncated: row?.truncated === true,
    outcome: shortOutcome,
    outcome_detail: detail,
    raw: typeof row?.raw === 'string' ? row.raw : '',
    tokens_used: toFinite(row?.tokens_used),
    comparable: row?.comparable === true,
    invoke_error: row?.invoke_error || null,
    panel_members: Array.isArray(row?.panel_members)
      ? row.panel_members.map((member) => ({
        model: typeof member?.model === 'string' ? member.model : null,
        output: typeof member?.output === 'string'
          ? member.output
          : member?.output == null ? null : JSON.stringify(member?.output),
      }))
      : [],
  };
}

function rate(successes, total) {
  return total > 0 ? successes / total : 0;
}

function percentDelta(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ((current - baseline) / baseline) * 100;
}

function classifyOutcome(row) {
  if (row?.outcome_detail) return row.outcome_detail;
  return outcomeDetail(row);
}

function groupRowsByArmAndCase(rows) {
  const byArm = new Map();
  const byCase = new Map();

  for (const row of rows) {
    if (!byArm.has(row.arm)) byArm.set(row.arm, []);
    byArm.get(row.arm).push(row);

    if (!byCase.has(row.case_id)) byCase.set(row.case_id, new Map());
    const byCaseArm = byCase.get(row.case_id);
    if (!byCaseArm.has(row.arm)) byCaseArm.set(row.arm, []);
    byCaseArm.get(row.arm).push(row);
  }

  for (const rowsForArm of byArm.values()) {
    rowsForArm.sort((left, right) => {
      if (left.case_id === right.case_id) {
        return (left.iteration ?? 0) - (right.iteration ?? 0);
      }
      return String(left.case_id).localeCompare(String(right.case_id));
    });
  }

  for (const byCaseArm of byCase.values()) {
    for (const rowsForCaseAndArm of byCaseArm.values()) {
      rowsForCaseAndArm.sort((left, right) => {
        return (left.iteration ?? 0) - (right.iteration ?? 0);
      });
    }
  }

  return { byArm, byCase };
}

function exactCombination(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const smaller = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= smaller; i += 1) {
    result *= (n - smaller + i) / i;
  }
  return result;
}

export function exactBinomialTail(successes, total, p) {
  if (!Number.isInteger(successes) || !Number.isInteger(total)) return 0;
  if (total < 0 || successes < 0 || successes > total) return 0;
  if (!Number.isFinite(p) || p < 0 || p > 1) return 0;
  if (total === 0) return successes === 0 ? 1 : 0;
  let pValue = 0;
  for (let n = successes; n <= total; n += 1) {
    const c = exactCombination(total, n);
    pValue += c * (p ** n) * ((1 - p) ** (total - n));
  }
  return Number(Math.min(1, Math.max(0, pValue)));
}

function isRecallIncreaseSignificant({
  baselineSuccesses,
  baselineTotal,
  candidateSuccesses,
  candidateTotal,
  baselineRecall,
  alpha = SIGNIFICANCE_ALPHA,
}) {
  if (!Number.isInteger(candidateSuccesses) || !Number.isInteger(candidateTotal) || candidateTotal <= 0) return false;
  if (!Number.isInteger(baselineSuccesses) || !Number.isInteger(baselineTotal) || baselineTotal < 0) return false;
  if (candidateSuccesses <= baselineSuccesses) return false;

  if (baselineRecall >= RECALL_CEILING_RECALL) return true;
  if (candidateSuccesses - baselineSuccesses < MIN_RECALL_GAIN) return false;

  const baselineRate = baselineTotal > 0 ? baselineSuccesses / baselineTotal : 0;
  const pValue = exactBinomialTail(candidateSuccesses, candidateTotal, baselineRate);
  return pValue < alpha;
}

function isIncreaseSignificant({
  baselineSuccesses,
  baselineTotal,
  candidateSuccesses,
  candidateTotal,
  alpha = SIGNIFICANCE_ALPHA,
}) {
  if (!Number.isInteger(candidateSuccesses) || !Number.isInteger(candidateTotal) || candidateTotal <= 0) return false;
  if (!Number.isInteger(baselineSuccesses) || !Number.isInteger(baselineTotal) || baselineTotal < 0) return false;
  if (candidateSuccesses <= baselineSuccesses) return false;

  const baselineRate = baselineTotal > 0 ? baselineSuccesses / baselineTotal : 0;
  const pValue = exactBinomialTail(candidateSuccesses, candidateTotal, baselineRate);
  return pValue < alpha;
}

function computeCaseFlipStats(caseRows) {
  const comparableRows = caseRows.sort((left, right) => {
    return (left.iteration ?? 0) - (right.iteration ?? 0);
  });
  if (comparableRows.length < 2) {
    return { flips: 0, opportunities: 0, rate: 0 };
  }

  let caseFlips = 0;
  for (let i = 1; i < comparableRows.length; i += 1) {
    const previous = classifyOutcome(comparableRows[i - 1]);
    const current = classifyOutcome(comparableRows[i]);
    if (previous !== current) caseFlips += 1;
  }
  const caseOpportunities = comparableRows.length - 1;
  return {
    flips: caseFlips,
    opportunities: caseOpportunities,
    rate: caseOpportunities > 0 ? caseFlips / caseOpportunities : 0,
  };
}

function computeFlip(rows) {
  const byCase = {};
  const byCaseAndArm = groupRowsByArmAndCase(rows).byCase;
  let flips = 0;
  let opportunities = 0;

  // Flip definition (per issue #36):
  // For each (case, arm), all recorded iterations are opportunities.
  // A flip is a change in adjacent outcomes.
  for (const [caseId, byArm] of byCaseAndArm.entries()) {
    for (const [arm, caseRows] of byArm.entries()) {
      if (!byCase[caseId]) byCase[caseId] = {};
      const caseFlip = computeCaseFlipStats(caseRows);
      byCase[caseId][arm] = caseFlip;
      flips += caseFlip.flips;
      opportunities += caseFlip.opportunities;
    }
  }

  return {
    flips,
    opportunities,
    by_case: byCase,
    rate: opportunities > 0 ? flips / opportunities : 0,
  };
}

function computeArmFlipStats(arm, rows) {
  const byCase = {};
  const flipsPerCase = new Map();

  for (const row of rows) {
    if (!flipsPerCase.has(row.case_id)) flipsPerCase.set(row.case_id, []);
    flipsPerCase.get(row.case_id).push(row);
  }

  let flips = 0;
  let opportunities = 0;
  for (const [caseId, groupedRows] of flipsPerCase.entries()) {
    const caseFlip = computeCaseFlipStats(groupedRows);
    byCase[caseId] = caseFlip;
    flips += caseFlip.flips;
    opportunities += caseFlip.opportunities;
  }

  return {
    arm,
    flips,
    opportunities,
    by_case: byCase,
    rate: opportunities > 0 ? flips / opportunities : 0,
  };
}

function computeArmStats(rows) {
  const caseIds = new Set();
  const tokensByCase = new Map();
  const casesWithTokens = new Set();
  const rowsByCase = new Map();
  const buggy = { total: 0, lenient_catches: 0, strict_catches: 0, warnings: 0, blocked: 0 };
  const clean = { total: 0, false_positives: 0, warnings: 0 };
  const raw_verdicts = [];
  let abstainedRows = 0;
  let rowCount = 0;
  let comparableCount = 0;

  function aggregateCaseOutcome(caseRows) {
    const required = requiredConsensus(caseRows.length);
    const outcomes = caseRows.map(classifyOutcome);
    const lenientHits = outcomes.filter((value) => LENIENT_OUTCOMES.has(value)).length;
    const strictHits = outcomes.filter((value) => value === 'BLOCKED').length;
    const warningHits = outcomes.filter((value) => value === 'WARNING').length;
    return {
      lenientCaught: lenientHits >= required,
      strictCaught: strictHits >= required,
      warningDominant: warningHits >= required,
      blockedDominant: strictHits >= required,
    };
  }

  for (const row of rows) {
    rowCount += 1;
    if (row.case_id) caseIds.add(row.case_id);
    if (row.comparable) comparableCount += 1;

    const outcome = classifyOutcome(row);
    const tokensForCase = toFinite(row.tokens_used);
    if (tokensForCase !== null) {
      casesWithTokens.add(row.case_id);
      tokensByCase.set(row.case_id, (tokensByCase.get(row.case_id) || 0) + tokensForCase);
    }
    if (outcome === ABSTAINED_OUTCOME) abstainedRows += 1;
    if (row.case_id) {
      if (!rowsByCase.has(row.case_id)) rowsByCase.set(row.case_id, []);
      rowsByCase.get(row.case_id).push(row);
    }

    raw_verdicts.push({
      case_id: row.case_id,
      arm: row.arm,
      iteration: row.iteration,
      ground_truth: row.ground_truth,
      outcome: row.outcome,
      outcome_detail: outcome,
      verdict: row.verdict,
      parse_ok: row.parse_ok,
      truncated: row.truncated,
      raw: row.raw,
    });
  }

  for (const [caseId, caseRows] of rowsByCase.entries()) {
    const groundTruth = normalizeGroundTruth(caseRows[0]?.ground_truth);
    if (!groundTruth) continue;

    const outcome = aggregateCaseOutcome(caseRows);

    if (groundTruth === 'buggy') {
      buggy.total += 1;
      if (outcome.lenientCaught) buggy.lenient_catches += 1;
      if (outcome.strictCaught) buggy.strict_catches += 1;
      if (outcome.warningDominant) buggy.warnings += 1;
      if (outcome.blockedDominant) buggy.blocked += 1;
      continue;
    }

    clean.total += 1;
    if (outcome.lenientCaught) clean.false_positives += 1;
    if (outcome.warningDominant) clean.warnings += 1;
  }

  const tokenCaseCount = casesWithTokens.size;
  const tokenValues = [...tokensByCase.values()];
  const totalTokens = tokenValues.length > 0 ? tokenValues.reduce((sum, tokenUsed) => sum + tokenUsed, 0) : null;
  const flip = computeArmFlipStats(rows[0]?.arm || '', rows);

  return {
    case_count: caseIds.size,
    row_count: rowCount,
    row_count_comparable: comparableCount,
    buggy_total: buggy.total,
    buggy_lenient_catches: buggy.lenient_catches,
    buggy_strict_catches: buggy.strict_catches,
    buggy_warning_count: buggy.warnings,
    buggy_blocked_count: buggy.blocked,
    clean_total: clean.total,
    clean_false_positives: clean.false_positives,
    clean_warning_count: clean.warnings,
    abstained_rows: abstainedRows,
    abstention_rate: rowCount > 0 ? abstainedRows / rowCount : 0,
    lenient_recall: rate(buggy.lenient_catches, buggy.total),
    strict_recall: rate(buggy.strict_catches, buggy.total),
    blocked_rate: rate(buggy.blocked, buggy.total),
    warning_ratio: rate(buggy.warnings, buggy.total),
    fp_rate: rate(clean.false_positives, clean.total),
    warning_fp_rate: rate(clean.warnings, clean.total),
    raw_verdicts,
    tokens_total: totalTokens,
    tokens_case_count: tokenCaseCount,
    tokens_per_case: totalTokens !== null && caseIds.size > 0 ? totalTokens / caseIds.size : null,
    flip,
    flip_rate: flip.rate,
  };
}

function parsePanelMemberVerdict(rawOutput) {
  const parsed = parseVerdict(rawOutput);
  return parsed?.verdict ?? null;
}

function collectPanelMembersByCase(panelRows) {
  const rowsByCase = new Map();
  const memberModelsByCase = new Map();
  const groundTruthByCase = new Map();

  for (const row of panelRows) {
    if (!row.case_id) continue;
    if (!rowsByCase.has(row.case_id)) rowsByCase.set(row.case_id, []);
    rowsByCase.get(row.case_id).push(row);

    if (row.ground_truth) {
      groundTruthByCase.set(row.case_id, row.ground_truth);
    }

    const members = memberModelsByCase.get(row.case_id) ?? new Set();
    for (const member of row.panel_members) {
      if (typeof member?.model === 'string' && member.model) {
        members.add(member.model);
      }
    }
    memberModelsByCase.set(row.case_id, members);
  }

  return { rowsByCase, memberModelsByCase, groundTruthByCase };
}

function computePanelVsBestMember(panelStats, panelRows) {
  if (!Array.isArray(panelRows) || panelRows.length === 0) {
    return {
      consensus_recall: panelStats?.lenient_recall ?? null,
      best_member_recall: null,
      best_member: null,
      delta: null,
    };
  }

  const { rowsByCase, memberModelsByCase, groundTruthByCase } = collectPanelMembersByCase(panelRows);
  const allMembers = new Set();
  for (const members of memberModelsByCase.values()) {
    for (const member of members) {
      allMembers.add(member);
    }
  }

  if (allMembers.size === 0) {
    return {
      consensus_recall: panelStats?.lenient_recall ?? null,
      best_member_recall: null,
      best_member: null,
      delta: null,
    };
  }

  let bestMember = null;
  let bestMemberRecall = null;

  for (const member of allMembers) {
    let buggyTotal = 0;
    let buggyCaught = 0;

    for (const [caseId, caseRows] of rowsByCase.entries()) {
      const groundTruth = normalizeGroundTruth(groundTruthByCase.get(caseId));
      if (!groundTruth) continue;

      const memberOutcome = caseRows.map((row) => {
        const memberRecord = row.panel_members.find((entry) => entry.model === member);
        return parsePanelMemberVerdict(memberRecord?.output);
      });

      const lenientHits = memberOutcome.filter((value) => LENIENT_OUTCOMES.has(value)).length;
      const lenientCaught = lenientHits >= requiredConsensus(memberOutcome.length);

      if (groundTruth === 'buggy') {
        buggyTotal += 1;
        if (lenientCaught) buggyCaught += 1;
      } else {
        // Keep FP tracking out of the canonical panel comparison object for now.
      }
    }

    const recall = rate(buggyCaught, buggyTotal);
    const isBetter = bestMember === null || recall > bestMemberRecall || (recall === bestMemberRecall && member < bestMember);
    if (isBetter) {
      bestMemberRecall = recall;
      bestMember = member;
    }
  }

  return {
    consensus_recall: panelStats?.lenient_recall ?? null,
    best_member_recall: bestMemberRecall,
    best_member: bestMember,
    delta: bestMemberRecall === null ? null : (panelStats?.lenient_recall ?? null) - bestMemberRecall,
  };
}

function computeTER(candidateRecall, baselineRecall, candidateTokens, baselineTokens) {
  const deltaRecall = percentDelta(candidateRecall, baselineRecall);
  const deltaTokens = percentDelta(candidateTokens, baselineTokens);
  if (deltaRecall === null || deltaTokens === null) return null;
  if (deltaTokens === 0) return deltaRecall > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return deltaRecall / deltaTokens;
}

function computeComparison(candidateArm, candidateStats, baselineStats) {
  const lenientGain = isRecallIncreaseSignificant({
    baselineSuccesses: baselineStats.buggy_lenient_catches,
    baselineTotal: baselineStats.buggy_total,
    candidateSuccesses: candidateStats.buggy_lenient_catches,
    candidateTotal: candidateStats.buggy_total,
    baselineRecall: baselineStats.lenient_recall,
  });
  const fpIncrease = isIncreaseSignificant({
    baselineSuccesses: baselineStats.clean_false_positives,
    baselineTotal: baselineStats.clean_total,
    candidateSuccesses: candidateStats.clean_false_positives,
    candidateTotal: candidateStats.clean_total,
  });

  return {
    candidate_arm: candidateArm,
    baseline_arm: BASELINE_ARM,
    lenient_recall: {
      baseline: baselineStats.lenient_recall,
      candidate: candidateStats.lenient_recall,
      delta: candidateStats.lenient_recall - baselineStats.lenient_recall,
      raw_successes: {
        baseline: baselineStats.buggy_lenient_catches,
        candidate: candidateStats.buggy_lenient_catches,
      },
      significant: lenientGain,
    },
    strict_recall: {
      baseline: baselineStats.strict_recall,
      candidate: candidateStats.strict_recall,
      delta: candidateStats.strict_recall - baselineStats.strict_recall,
    },
    fp_rate: {
      baseline: baselineStats.fp_rate,
      candidate: candidateStats.fp_rate,
      delta: candidateStats.fp_rate - baselineStats.fp_rate,
      significant: fpIncrease,
    },
    blocked_rate: {
      baseline: baselineStats.blocked_rate,
      candidate: candidateStats.blocked_rate,
      delta: candidateStats.blocked_rate - baselineStats.blocked_rate,
    },
    tokens_per_case: {
      baseline: baselineStats.tokens_per_case,
      candidate: candidateStats.tokens_per_case,
      delta: Number.isFinite(candidateStats.tokens_per_case) && Number.isFinite(baselineStats.tokens_per_case)
        ? candidateStats.tokens_per_case - baselineStats.tokens_per_case
        : null,
    },
    ter: computeTER(
      candidateStats.lenient_recall,
      baselineStats.lenient_recall,
      candidateStats.tokens_per_case,
      baselineStats.tokens_per_case,
    ),
  };
}

function computeGuardrailResult(candidateStats, baselineStats, comparison) {
  const fp_not_worse = !isIncreaseSignificant({
    baselineSuccesses: baselineStats.clean_false_positives,
    baselineTotal: baselineStats.clean_total,
    candidateSuccesses: candidateStats.clean_false_positives,
    candidateTotal: candidateStats.clean_total,
  });

  const ter = comparison.ter;
  const hasTokenBudget = Number.isFinite(candidateStats.tokens_per_case) && Number.isFinite(baselineStats.tokens_per_case);
  const hardCeiling = hasTokenBudget ? baselineStats.tokens_per_case * 1.5 : Number.POSITIVE_INFINITY;
  const tokenBudgetOk = hasTokenBudget
    ? (candidateStats.tokens_per_case <= baselineStats.tokens_per_case
      || (Number.isFinite(ter) && ter >= 1 && candidateStats.tokens_per_case <= hardCeiling))
    : true;

  const flipThreshold = Math.max(baselineStats.flip_rate || 0, 0.05);
  const flipOk = candidateStats.flip_rate <= flipThreshold;
  const noDowngrade = candidateStats.blocked_rate >= baselineStats.blocked_rate;

  return {
    guardrail_1_fp_not_worse: fp_not_worse,
    guardrail_2_tokens_budget: tokenBudgetOk,
    guardrail_3_flip_stability: flipOk,
    guardrail_4_no_downgrade: noDowngrade,
    ter,
  };
}

function summarizeByCase(byCase) {
  const out = {};
  for (const [caseId, armMap] of byCase.entries()) {
    out[caseId] = {};
    for (const [arm, rows] of armMap.entries()) {
      out[caseId][arm] = rows;
    }
  }
  return out;
}

function summarizeFlipByCase(armStats) {
  const byCase = {};
  for (const [arm, stats] of Object.entries(armStats)) {
    for (const [caseId, payload] of Object.entries(stats.flip.by_case)) {
      byCase[caseId] = byCase[caseId] || {};
      byCase[caseId][arm] = payload;
    }
  }
  return byCase;
}

function makeEmptySummary() {
  return {
    row_count: 0,
    row_count_comparable: 0,
    case_count: 0,
    by_arm: {},
    by_case: {},
    baseline_arm: BASELINE_ARM,
    comparisons: {},
    flip: {
      by_arm: {},
      total: { flips: 0, opportunities: 0, rate: 0, by_case: {} },
    },
    abstained_rows: 0,
    abstention_rate: 0,
    cost_usd: null,
    panel_vs_best_member: null,
    guardrails: {},
  };
}

export function aggregate(rows, {
  cost_usd: costUsd = null,
} = {}) {
  const normalized = rows.map((row, index) => normalizeRow(row, index));
  if (!normalized.length) {
    const summary = makeEmptySummary();
    summary.cost_usd = normalizeCost(costUsd);
    return summary;
  }

  const { byArm: rowsByArm, byCase: caseByArm } = groupRowsByArmAndCase(normalized);
  const byArm = {};
  let abstainedRows = 0;

  for (const [arm, armRows] of rowsByArm.entries()) {
    byArm[arm] = computeArmStats(armRows);
    abstainedRows += byArm[arm].abstained_rows || 0;
  }
  const normalizedCostUsd = normalizeCost(costUsd);
  const totalRows = normalized.length;

  const by_case = summarizeByCase(caseByArm);
  const baselineStats = byArm[BASELINE_ARM];
  const panelVsBestMember = computePanelVsBestMember(byArm.panel, byArm.panel ? rowsByArm?.get('panel') || [] : []);

  if (!baselineStats) {
    return {
      row_count: totalRows,
      row_count_comparable: normalized.filter((row) => row.comparable).length,
      case_count: new Set(normalized.map((row) => row.case_id)).size,
      abstained_rows: abstainedRows,
      abstention_rate: totalRows > 0 ? abstainedRows / totalRows : 0,
      cost_usd: normalizedCostUsd,
      by_arm: byArm,
      by_case,
      baseline_arm: BASELINE_ARM,
      comparisons: {},
      panel_vs_best_member: panelVsBestMember,
      flip: {
        by_arm: Object.fromEntries(Object.entries(byArm).map(([arm, stats]) => [arm, stats.flip])),
        total: {
          flips: 0,
          opportunities: 0,
          rate: 0,
          by_case: {},
        },
      },
      guardrails: {},
    };
  }

  const comparisons = {};
  const guardrails = {};
  for (const [arm, candidateStats] of Object.entries(byArm)) {
    if (arm === BASELINE_ARM) continue;
    const comparison = computeComparison(arm, candidateStats, baselineStats);
    comparisons[arm] = comparison;
    guardrails[arm] = computeGuardrailResult(candidateStats, baselineStats, comparison);
  }

  const totalFlip = computeFlip(normalized);
  return {
    row_count: totalRows,
    row_count_comparable: normalized.filter((row) => row.comparable).length,
    case_count: new Set(normalized.map((row) => row.case_id)).size,
    abstained_rows: abstainedRows,
    abstention_rate: totalRows > 0 ? abstainedRows / totalRows : 0,
    cost_usd: normalizedCostUsd,
    by_arm: byArm,
    by_case,
    baseline_arm: BASELINE_ARM,
    comparisons,
    panel_vs_best_member: panelVsBestMember,
    flip: {
      by_arm: Object.fromEntries(Object.entries(byArm).map(([arm, stats]) => [arm, {
        flips: stats.flip.flips,
        opportunities: stats.flip.opportunities,
        rate: stats.flip.rate,
        by_case: stats.flip.by_case,
      }])),
      total: totalFlip,
      by_case: summarizeFlipByCase(byArm),
    },
    guardrails,
  };
}
