#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Live ocask eval runner with injectable seams for deterministic tests.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ARM_LABELS, runOcaskArm } from './arm.mjs';
import { aggregate } from './metrics.mjs';
import { freezeBaselineFromCorpus } from './matrix.mjs';

const RUN_LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_PATH = path.join(RUN_LIVE_DIR, 'corpus', 'cases.json');
const DEFAULT_OCASK_PATH = path.join(RUN_LIVE_DIR, '..', 'ocask.mjs');
const RESULTS_PATH = path.join(RUN_LIVE_DIR, 'baseline', 'run-live-results.json');
const FROZEN_BASELINE_PATH = path.join(RUN_LIVE_DIR, 'baseline', 'frozen-baseline.json');
const DEFAULT_LIVE_CAP_USD = 1;
const DEFAULT_LIVE_CONCURRENCY = 5;
const LIVE_TIMEOUT_MS = 900000;
const LIVE_TEMPERATURE = 0;
const LIVE_ITERATIONS = 3;
const LIVE_ATTEMPT_BLOCK = 15;
const DEFAULT_OUTPUT_MODE = 'json';

function parseCapFromEnv(env, fallback) {
  const parsed = Number(env.EVAL_LIVE_CAP_USD);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function liveCapFromEnv(env = process.env) {
  return parseCapFromEnv(env, DEFAULT_LIVE_CAP_USD);
}

function normalizeOutputMode(value = DEFAULT_OUTPUT_MODE) {
  if (value === 'json' || value === 'text') return value;
  throw new Error(`Unsupported eval output mode: ${value}. Expected "json" or "text".`);
}

function liveOutputModeFromEnv(env = process.env) {
  return normalizeOutputMode(env.EVAL_OUTPUT_MODE || DEFAULT_OUTPUT_MODE);
}

function liveConcurrencyFromEnv(env = process.env) {
  const parsed = Number.parseInt(env.EVAL_LIVE_CONCURRENCY, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_LIVE_CONCURRENCY;
}

function describeEntryGate(env = process.env) {
  return env.RUN_LIVE_EVAL !== 'true'
    ? 'Offline harness is enabled by default. Set RUN_LIVE_EVAL=true to opt into live execution.'
    : null;
}

async function loadCorpus(corpusPath = DEFAULT_CORPUS_PATH) {
  const payload = await fs.readFile(corpusPath, 'utf8');
  return JSON.parse(payload);
}

function toTaskIdentifier(caseRecord, index) {
  return String(caseRecord.case_id ?? caseRecord.id ?? index ?? '');
}

function parseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function ensureInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function isPanelRequest(request) {
  return request?.arm === 'panel' || request?.panel === true;
}

function mapPanelFamily(model) {
  return /qwen/i.test(String(model || '')) ? 'qwen' : 'deepseek';
}

function mapPanelMembers(rawMembers = []) {
  if (!Array.isArray(rawMembers)) return [];
  return rawMembers.map((member) => ({
    model: typeof member?.model === 'string' ? member.model : null,
    family: mapPanelFamily(member?.model),
    output: JSON.stringify({
      verdict: member?.verdict ?? null,
      output: member?.output_preview || '',
    }),
  }));
}

function normalizeAttempts(parsed) {
  if (Array.isArray(parsed?.attempts)) return parsed.attempts;
  if (Array.isArray(parsed?.metadata?.attempts)) return parsed.metadata.attempts;
  return [{}];
}

function buildSpawnArgs(request, diffPath, specPath) {
  const outputMode = normalizeOutputMode(request?.output_mode);
  const args = [
    '--model',
    request.model,
    '--task',
    diffPath,
    '--context',
    specPath,
    '--require-verdict',
    '--temperature',
    String(LIVE_TEMPERATURE),
    '--timeout-ms',
    String(LIVE_TIMEOUT_MS),
  ];

  if (outputMode === 'json') {
    args.push('--json');
  }

  if (isPanelRequest(request)) {
    args.push('--panel');
  } else {
    args.push('--lens', request.lens || 'general');
  }

  return args;
}

function readStreamFully(stream) {
  if (!stream || typeof stream.on !== 'function') {
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    let output = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += String(chunk);
    });
    stream.on('error', () => {
      resolve(output);
    });
    stream.on('end', () => {
      resolve(output);
    });
  });
}

async function runCommand(command, args, { spawnImpl = spawn } = {}) {
  const spawned = await Promise.resolve(spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false }));

  if (spawned == null) {
    return { stdout: '', stderr: '', exitCode: 1 };
  }

  if (typeof spawned.then === 'function') {
    const resolved = await spawned;
    return {
      stdout: typeof resolved?.stdout === 'string' ? resolved.stdout : '',
      stderr: typeof resolved?.stderr === 'string' ? resolved.stderr : '',
      exitCode: ensureInt(resolved?.exitCode ?? resolved?.status ?? 0, 0),
    };
  }

  if (typeof spawned === 'string' || typeof spawned === 'number' || typeof spawned === 'boolean') {
    return { stdout: String(spawned), stderr: '', exitCode: 0 };
  }

  if (typeof spawned.stdout !== 'object' || typeof spawned.on !== 'function') {
    return {
      stdout: spawned.stdout == null ? '' : String(spawned.stdout),
      stderr: spawned.stderr == null ? '' : String(spawned.stderr),
      exitCode: ensureInt(spawned.exitCode ?? spawned.status ?? spawned.code ?? 0, 0),
    };
  }

  const [stdout, stderr] = await Promise.all([
    readStreamFully(spawned.stdout),
    readStreamFully(spawned.stderr),
  ]);

  const exitCode = await new Promise((resolve, reject) => {
    let closed = false;
    const done = (code) => {
      if (!closed) {
        closed = true;
        resolve(ensureInt(code, 0));
      }
    };
    spawned.once('error', (error) => {
      if (!closed) {
        closed = true;
        reject(error);
      }
    });
    spawned.once('close', done);
  });

  return {
    stdout,
    stderr,
    exitCode,
  };
}

function parseLiveOutput(raw, exitCode, request) {
  const payload = parseJson(raw);
  if (payload === null) {
    return {
      output: typeof raw === 'string' ? raw : String(raw ?? ''),
      panel_members: [],
      metadata: {
        attempts: [{}],
        exit_code: ensureInt(exitCode, 0),
      },
    };
  }

  return {
    output: JSON.stringify(payload),
    panel_members: isPanelRequest(request)
      ? mapPanelMembers(payload.members)
      : [],
    metadata: {
      attempts: normalizeAttempts(payload),
      exit_code: ensureInt(exitCode, 0),
    },
  };
}

async function withTempFiles(diff, spec, callback) {
  const prefix = path.join(os.tmpdir(), 'ocask-live-');
  const tempDir = await fs.mkdtemp(prefix);
  const diffPath = path.join(tempDir, 'diff.patch');
  const specPath = path.join(tempDir, 'spec.txt');
  try {
    await Promise.all([
      fs.writeFile(diffPath, diff ?? '', 'utf8'),
      fs.writeFile(specPath, spec ?? '', 'utf8'),
    ]);
    return callback({ diffPath, specPath });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function liveInvoke(request, { ocaskPath = DEFAULT_OCASK_PATH, spawnImpl = spawn } = {}) {
  return withTempFiles(request?.diff, request?.spec, async ({ diffPath, specPath }) => {
    const argsWithPaths = buildSpawnArgs(request, diffPath, specPath);

    const { stdout, exitCode } = await runCommand(process.execPath, [ocaskPath, ...argsWithPaths], { spawnImpl });
    return parseLiveOutput(stdout, exitCode, request);
  });
}

async function snapshotCostFromOcask({ ocaskPath = DEFAULT_OCASK_PATH, spawnImpl = spawn } = {}) {
  const payload = parseJson((await runCommand(process.execPath, [ocaskPath, 'cost', '--json'], { spawnImpl })).stdout);
  if (!payload || !Array.isArray(payload.per_model)) return 0;

  return payload.per_model.reduce((total, entry) => {
    const value = Number(entry?.total_cost_usd);
    if (!Number.isFinite(value)) return total;
    return total + value;
  }, 0);
}

export async function runLiveMatrix(cases, {
  invoke,
  concurrency = DEFAULT_LIVE_CONCURRENCY,
  capUsd = DEFAULT_LIVE_CAP_USD,
  costSnapshotFn = null,
  outputMode = DEFAULT_OUTPUT_MODE,
} = {}) {
  if (!Array.isArray(cases)) {
    throw new TypeError('runLiveMatrix requires a case array');
  }
  if (typeof invoke !== 'function') {
    throw new TypeError('runLiveMatrix requires an invoke function');
  }
  // Safety: a finite spend cap without a real cost seam would run uncapped and
  // silently spend money. Fail fast instead of defaulting to a no-op cost source.
  if (Number.isFinite(capUsd) && typeof costSnapshotFn !== 'function') {
    throw new TypeError('runLiveMatrix: capUsd is set but no costSnapshotFn was provided — refusing to run uncapped');
  }
  const selectedOutputMode = normalizeOutputMode(outputMode);
  const invokeInSelectedMode = (request) => invoke({
    ...request,
    output_mode: selectedOutputMode,
  });

  const poolSize = concurrency > 0 ? Math.floor(concurrency) : DEFAULT_LIVE_CONCURRENCY;
  const expectedRowsPerCase = ARM_LABELS.length * LIVE_ITERATIONS;
  const expectedRows = cases.length * expectedRowsPerCase;

  const tasks = [];
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const caseRecord = cases[caseIndex];
    const caseId = toTaskIdentifier(caseRecord, caseIndex);
    for (const arm of ARM_LABELS) {
      for (let iteration = 1; iteration <= LIVE_ITERATIONS; iteration += 1) {
        tasks.push({
          caseRecord,
          caseIndex,
          caseId,
          arm,
          iteration,
        });
      }
    }
  }

  const rows = [];
  const perCaseRows = new Map();
  let spentUsd = 0;
  let aborted = false;
  let completedRows = 0;

  for (let index = 0; index < tasks.length && !aborted; index += poolSize) {
    const batch = tasks.slice(index, Math.min(index + poolSize, tasks.length));
    const batchRows = await Promise.all(batch.map((task) => (
      runOcaskArm(task.caseRecord, task.arm, {
        invoke: invokeInSelectedMode,
        iteration: task.iteration,
        case_id: task.caseId,
        caseIndex: task.caseIndex,
      })
    )));

    for (let batchIndex = 0; batchIndex < batchRows.length; batchIndex += 1) {
      const row = batchRows[batchIndex];
      if (row) {
        rows.push(row);
        completedRows += 1;
        perCaseRows.set(row.case_id, (perCaseRows.get(row.case_id) ?? 0) + 1);
      }

      if (completedRows > 0 && completedRows % LIVE_ATTEMPT_BLOCK === 0) {
        const snapshot = await costSnapshotFn();
        if (Number.isFinite(snapshot)) spentUsd = snapshot;
        if (spentUsd > capUsd) {
          aborted = true;
          break;
        }
      }
    }
  }

  const completion_ratio = expectedRows ? rows.length / expectedRows : 0;
  const completedCases = [...perCaseRows.entries()]
    .filter((entry) => entry[1] >= expectedRowsPerCase)
    .length;
  const case_completion_ratio = cases.length ? completedCases / cases.length : 0;
  const baseline = freezeBaselineFromCorpus(case_completion_ratio, rows, {
    requiredCaseCompletion: 0.8,
    cost_usd: spentUsd,
  });
  const metrics = aggregate(rows, { cost_usd: spentUsd });

  const runCompleted = case_completion_ratio >= 0.8;
  return {
    status: runCompleted ? 'COMPLETED' : 'FAILED',
    total_calls: rows.length,
    expected_calls: expectedRows,
    completion_ratio,
    case_completion_ratio,
    rows,
    aggregate: metrics,
    baseline,
    can_freeze_baseline: runCompleted && baseline !== null,
    spent_usd: spentUsd,
    cost_usd: spentUsd,
    case_count: cases.length,
    completed_case_count: completedCases,
    arm_count: ARM_LABELS.length,
    iterations: LIVE_ITERATIONS,
    concurrency: poolSize,
    cap_usd: capUsd,
    output_mode: selectedOutputMode,
  };
}

export function buildFrozenBaselinePayload(result, {
  capUsd,
  concurrency,
  outputMode = result.output_mode ?? DEFAULT_OUTPUT_MODE,
  systemUnderTest = {
    path: null,
    git_ref: null,
    git_commit: null,
    dirty: null,
    resolution: 'unresolved',
  },
}) {
  const run = {
    cases: result.case_count,
    arms: ARM_LABELS,
    iterations: result.iterations,
    completion_ratio: result.completion_ratio,
    total_calls: result.total_calls,
    spent_usd: result.spent_usd,
    cap_usd: capUsd,
    concurrency,
  };

  const byArm = {};
  for (const [arm, stats] of Object.entries(result.aggregate?.by_arm ?? {})) {
    byArm[arm] = {
      lenient_recall: stats.lenient_recall,
      strict_recall: stats.strict_recall,
      fp_rate: stats.fp_rate,
      abstention_rate: stats.abstention_rate,
      flip_rate: stats.flip_rate,
      blocked_rate: stats.blocked_rate,
      tokens_per_case: stats.tokens_per_case,
      ter: result.aggregate?.comparisons?.[arm]?.ter ?? null,
    };
  }

  return {
    frozen_at: new Date().toISOString().slice(0, 10),
    phase: 'T08',
    system_under_test: systemUnderTest,
    output_mode: normalizeOutputMode(outputMode),
    run,
    per_arm: byArm,
    comparisons_vs_control: result.aggregate?.comparisons ?? null,
    panel_vs_best_member: result.aggregate?.panel_vs_best_member ?? null,
    notes: 'Canonical frozen baseline generated from run-live aggregate metrics.',
  };
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function resolveSystemUnderTest(ocaskPath, { spawnImpl = spawn } = {}) {
  let resolvedOcaskPath = path.resolve(ocaskPath);
  try {
    resolvedOcaskPath = await fs.realpath(resolvedOcaskPath);
  } catch {
    // Keep the requested path so an unresolved payload still identifies the target.
  }

  const unresolved = {
    path: resolvedOcaskPath,
    git_ref: null,
    git_commit: null,
    dirty: null,
    resolution: 'unresolved',
  };

  try {
    const checkoutDir = path.dirname(resolvedOcaskPath);
    const rootResult = await runCommand('git', [
      '-C', checkoutDir, 'rev-parse', '--show-toplevel',
    ], { spawnImpl });
    const repositoryRoot = rootResult.stdout.trim();
    if (rootResult.exitCode !== 0 || !repositoryRoot) return unresolved;

    const [commitResult, refResult, statusResult] = await Promise.all([
      runCommand('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { spawnImpl }),
      runCommand('git', ['-C', repositoryRoot, 'symbolic-ref', '-q', '--short', 'HEAD'], { spawnImpl }),
      runCommand('git', ['-C', repositoryRoot, 'status', '--porcelain'], { spawnImpl }),
    ]);
    const gitCommit = commitResult.stdout.trim();
    if (commitResult.exitCode !== 0 || !gitCommit) return unresolved;

    return {
      path: path.relative(repositoryRoot, resolvedOcaskPath) || path.basename(resolvedOcaskPath),
      git_ref: refResult.exitCode === 0 && refResult.stdout.trim()
        ? refResult.stdout.trim()
        : 'HEAD (detached)',
      git_commit: gitCommit,
      dirty: statusResult.exitCode === 0 ? statusResult.stdout.trim().length > 0 : null,
      resolution: 'resolved',
    };
  } catch {
    return unresolved;
  }
}

export async function persistLiveRunArtifacts(result, {
  env = process.env,
  ocaskPath = DEFAULT_OCASK_PATH,
  resultsPath = RESULTS_PATH,
  frozenBaselinePath = FROZEN_BASELINE_PATH,
  capUsd = DEFAULT_LIVE_CAP_USD,
  concurrency = DEFAULT_LIVE_CONCURRENCY,
  writeJsonFn = writeJson,
  resolveSystemUnderTestFn = resolveSystemUnderTest,
  systemUnderTest = null,
} = {}) {
  const freezeRequested = env.EVAL_FREEZE_BASELINE === 'true';
  const canFreeze = freezeRequested && result.can_freeze_baseline && result.baseline;
  const measuredSystem = canFreeze
    ? systemUnderTest ?? await resolveSystemUnderTestFn(ocaskPath)
    : null;

  await writeJsonFn(resultsPath, result);

  if (!canFreeze) {
    return { baseline_frozen: false };
  }

  const frozen = buildFrozenBaselinePayload(result, {
    capUsd,
    concurrency,
    outputMode: result.output_mode,
    systemUnderTest: measuredSystem,
  });
  await writeJsonFn(frozenBaselinePath, frozen);
  return { baseline_frozen: true, system_under_test: measuredSystem };
}

export async function runLive({
  env = process.env,
  invoke,
  costSnapshotFn = null,
  capUsd = liveCapFromEnv(env),
  concurrency = liveConcurrencyFromEnv(env),
  outputMode = liveOutputModeFromEnv(env),
} = {}) {
  const gateMessage = describeEntryGate(env);
  if (gateMessage) {
    return { status: 'SKIPPED', reason: gateMessage };
  }

  if (!invoke) {
    throw new Error('runLive requires an invoke function when RUN_LIVE_EVAL=true');
  }
  if (Number.isFinite(capUsd) && capUsd > 0 && typeof costSnapshotFn !== 'function') {
    throw new Error('runLive requires a cost snapshot seam when a live cap is configured.');
  }

  const corpus = await loadCorpus();
  return runLiveMatrix(corpus, {
    invoke,
    concurrency,
    capUsd,
    costSnapshotFn,
    outputMode,
  });
}

export async function executeLiveRun({
  env = process.env,
  ocaskPath = DEFAULT_OCASK_PATH,
  invoke,
  costSnapshotFn,
  capUsd = liveCapFromEnv(env),
  concurrency = liveConcurrencyFromEnv(env),
  outputMode = liveOutputModeFromEnv(env),
  runLiveFn = runLive,
  persistLiveRunArtifactsFn = persistLiveRunArtifacts,
  resolveSystemUnderTestFn = resolveSystemUnderTest,
} = {}) {
  const systemUnderTest = env.EVAL_FREEZE_BASELINE === 'true'
    ? await resolveSystemUnderTestFn(ocaskPath)
    : null;
  const result = await runLiveFn({
    env,
    invoke,
    costSnapshotFn,
    capUsd,
    concurrency,
    outputMode,
  });
  const persistence = await persistLiveRunArtifactsFn(result, {
    env,
    ocaskPath,
    capUsd,
    concurrency,
    systemUnderTest,
  });
  return { result, persistence };
}

async function main() {
  const env = process.env;
  const gateMessage = describeEntryGate(env);
  if (gateMessage) {
    console.log(gateMessage);
    return;
  }

  const capUsd = liveCapFromEnv(env);
  const concurrency = liveConcurrencyFromEnv(env);
  const outputMode = liveOutputModeFromEnv(env);
  const ocaskPath = env.EVAL_OCASK_PATH || DEFAULT_OCASK_PATH;
  let baselineCost = null;
  const costSnapshotFn = async () => {
    const totalCost = await snapshotCostFromOcask({ ocaskPath, spawnImpl: spawn });
    if (baselineCost === null) {
      baselineCost = totalCost;
      return 0;
    }
    const delta = totalCost - baselineCost;
    return delta >= 0 ? delta : 0;
  };

  const invoke = (request) => liveInvoke(request, {
    ocaskPath,
    spawnImpl: spawn,
  });

  const { result, persistence } = await executeLiveRun({
    env,
    ocaskPath,
    invoke,
    costSnapshotFn,
    capUsd,
    concurrency,
    outputMode,
  });

  console.log(`RUN_LIVE_EVAL completed: ${result.status}.`);
  console.log(`Saved run output: ${RESULTS_PATH}`);
  if (persistence.baseline_frozen) {
    console.log(`Explicitly replaced frozen baseline: ${FROZEN_BASELINE_PATH}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
