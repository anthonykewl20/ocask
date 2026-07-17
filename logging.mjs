// Structured observability: JSONL append-only log for invocation tracing,
// provider health, flake detection, and diagnostic analysis.
// Log path: XDG_DATA_HOME/ocask/log.jsonl (~/.local/share/ocask/log.jsonl)

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

const LOG_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'ocask'
);
const LOG_PATH = path.join(LOG_DIR, 'log.jsonl');
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB before rotation
const ROTATION_KEEP = 2; // keep this many rotated files

// ── Init ──
async function ensureLogDir() {
  await fs.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
}

// ── Rotation ──
async function maybeRotate() {
  try {
    const stat = await fs.stat(LOG_PATH);
    if (stat.size > MAX_LOG_BYTES) {
      for (let i = ROTATION_KEEP - 1; i >= 0; i--) {
        const old = i === 0 ? LOG_PATH : `${LOG_PATH}.${i}`;
        const next = `${LOG_PATH}.${i + 1}`;
        try { await fs.rename(old, next); } catch { /* ok */ }
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

// ── Write ──
export async function logEvent(event, data = {}) {
  await ensureLogDir();
  await maybeRotate();
  const line = JSON.stringify({
    v: 1,
    ts: new Date().toISOString(),
    event,
    ...data,
  }) + '\n';
  await fs.appendFile(LOG_PATH, line, { mode: 0o600 });
  // Best-effort chmod in case file was just created
  try { await fs.chmod(LOG_PATH, 0o600); } catch { /* ok */ }
}

// ── High-level log helpers ──
export function makeRunId() {
  return randomBytes(8).toString('hex');
}

let _currentRunId = null;

export function startRun(runId) {
  _currentRunId = runId;
}

export async function logRunStart({ model, lens, provider, promptHash, inputBytes, timeoutMs }) {
  await logEvent('run.start', {
    run_id: _currentRunId,
    model,
    lens,
    provider_pref: provider || 'auto',
    prompt_hash: promptHash,
    input_bytes: inputBytes,
    timeout_ms: timeoutMs || 0,
  });
}

export async function logAttemptStart({ provider, model, attemptIndex }) {
  await logEvent('attempt.start', {
    run_id: _currentRunId,
    provider,
    model,
    attempt_index: attemptIndex,
  });
}

export async function logAttemptResult({ provider, model, attemptIndex, outcome, durationMs,
  reasonCode, outputBytes, tokensUsed, errorClass }) {
  await logEvent('attempt.result', {
    run_id: _currentRunId,
    provider,
    model,
    attempt_index: attemptIndex,
    outcome,
    duration_ms: durationMs,
    reason_code: reasonCode || 'ok',
    output_bytes: outputBytes || 0,
    tokens_used: tokensUsed,
    error_class: errorClass || null,
  });
}

export async function logFallback({ fromProvider, toProvider, fromModel, toModel, reason }) {
  await logEvent('fallback', {
    run_id: _currentRunId,
    from_provider: fromProvider,
    to_provider: toProvider,
    from_model: fromModel,
    to_model: toModel,
    reason,
  });
}

export async function logVerdict({ verdict, model, provider, lens, durationMs, briefRationale }) {
  await logEvent('verdict', {
    run_id: _currentRunId,
    verdict,
    model,
    provider,
    lens,
    duration_ms: durationMs,
    brief: briefRationale?.slice(0, 200) || null,
  });
}

export async function logError({ model, provider, errorCode, errorClass, attemptCount, durationMs }) {
  await logEvent('error', {
    run_id: _currentRunId,
    model,
    provider,
    error_code: errorCode,
    error_class: errorClass,
    attempts_exhausted: attemptCount,
    duration_ms: durationMs,
  });
}

export function currentRunId() {
  return _currentRunId;
}

// ── Doctor: read and analyze the log ──
export async function readLog(options = {}) {
  const { since, until, limit } = options;
  if (!fsSync.existsSync(LOG_PATH)) return [];

  const lines = [];
  const stream = (await fs.open(LOG_PATH, 'r')).createReadStream();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const part of parts) {
      if (!part.trim()) continue;
      try {
        const entry = JSON.parse(part);
        if (since && new Date(entry.ts) < new Date(since)) continue;
        if (until && new Date(entry.ts) > new Date(until)) continue;
        lines.push(entry);
      } catch { /* skip malformed */ }
    }
  }
  return limit ? lines.slice(-limit) : lines;
}

export async function doctorReport(options = {}) {
  const entries = await readLog(options);
  const sysHealth = options.system !== false ? await (async () => {
    try { const { systemHealth } = await import('./system.mjs'); return await systemHealth(); } catch { return null; }
  })() : null;

  if (entries.length === 0 && !sysHealth) return { status: 'empty', message: 'No log entries or system data found. Run ocask first.' };

  const runs = {};
  const providerStats = {};
  const modelStats = {};

  for (const e of entries) {
    const rid = e.run_id;
    if (!rid) continue;

    if (e.event === 'run.start') {
      runs[rid] = { model: e.model, lens: e.lens, provider: e.provider_pref, started: e.ts, attempts: [], verdict: null, error: null };
    }
    if (e.event === 'attempt.result') {
      if (runs[rid]) runs[rid].attempts.push(e);
      const key = `${e.provider}/${e.model}`;
      if (!providerStats[key]) providerStats[key] = { total: 0, success: 0, errors: {}, total_ms: 0, tokens: 0 };
      providerStats[key].total++;
      providerStats[key].total_ms += e.duration_ms || 0;
      providerStats[key].tokens += e.tokens_used || 0;
      if (e.outcome === 'success') providerStats[key].success++;
      else {
        const code = e.reason_code || 'unknown';
        providerStats[key].errors[code] = (providerStats[key].errors[code] || 0) + 1;
      }
    }
    if (e.event === 'verdict') {
      if (runs[rid]) runs[rid].verdict = e.verdict;
    }
    if (e.event === 'error') {
      if (runs[rid]) runs[rid].error = e.error_code;
    }
  }

  // Compute stats
  const totalRuns = Object.keys(runs).length;
  const successfulRuns = Object.values(runs).filter(r => r.verdict && !r.error).length;
  const failedRuns = Object.values(runs).filter(r => r.error).length;
  const verdictDist = { APPROVED: 0, WARNING: 0, BLOCKED: 0 };
  for (const r of Object.values(runs)) {
    if (r.verdict && verdictDist[r.verdict] !== undefined) verdictDist[r.verdict]++;
  }

  // Flake detection: same provider failing then succeeding on retry within same run
  const flakes = [];
  for (const [rid, run] of Object.entries(runs)) {
    const attempts = run.attempts || [];
    for (let i = 0; i < attempts.length - 1; i++) {
      if (attempts[i].outcome === 'failed' && attempts[i + 1].outcome === 'success') {
        const from = attempts[i];
        const to = attempts[i + 1];
        flakes.push({
          run_id: rid,
          flaky_provider: from.provider,
          flaky_model: from.model,
          error_code: from.reason_code,
          recovered_by: to.provider,
          recovered_model: to.model,
        });
      }
    }
  }

  // Provider health summary
  const providers = Object.entries(providerStats).map(([key, stats]) => ({
    provider_model: key,
    total: stats.total,
    success_rate: stats.total > 0 ? (stats.success / stats.total * 100).toFixed(1) + '%' : 'N/A',
    avg_latency_ms: stats.total > 0 ? Math.round(stats.total_ms / stats.total) : 0,
    error_breakdown: stats.errors,
    total_tokens: stats.tokens,
  })).sort((a, b) => b.total - a.total);

  // Top enhancement opportunities (most common error codes)
  const errorCounts = {};
  for (const [, stats] of Object.entries(providerStats)) {
    for (const [code, count] of Object.entries(stats.errors)) {
      errorCounts[code] = (errorCounts[code] || 0) + count;
    }
  }
  const topErrors = Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => ({ error_code: code, count }));

  return {
    status: 'ok',
    summary: {
      total_runs: totalRuns,
      successful: successfulRuns,
      failed: failedRuns,
      verdict_distribution: verdictDist,
      date_range: entries.length > 0 ? `${entries[0].ts} → ${entries[entries.length - 1].ts}` : 'N/A',
    },
    providers,
    flakes: flakes.slice(0, 10),
    top_errors: topErrors,
    suggestions: generateSuggestions(providers, flakes, topErrors),
    system: sysHealth,
  };
}

function generateSuggestions(providers, flakes, topErrors) {
  const suggestions = [];

  for (const p of providers) {
    const rate = parseFloat(p.success_rate);
    if (rate < 50 && p.total >= 5) {
      suggestions.push({ severity: 'high', action: `Provider ${p.provider_model} has ${p.success_rate} success rate over ${p.total} attempts. Consider removing from fallback chain or rotating credentials.` });
    }
    if (p.avg_latency_ms > 30000) {
      suggestions.push({ severity: 'medium', action: `Provider ${p.provider_model} avg latency ${p.avg_latency_ms}ms. Consider increasing --timeout-ms or switching provider.` });
    }
  }

  const flakeByProvider = {};
  for (const f of flakes) {
    const key = `${f.flaky_provider}/${f.flaky_model}`;
    flakeByProvider[key] = (flakeByProvider[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(flakeByProvider)) {
    if (count >= 3) {
      suggestions.push({ severity: 'high', action: `Flaky provider detected: ${key} failed then recovered ${count} times. ${flakes.find(f => `${f.flaky_provider}/${f.flaky_model}` === key)?.error_code} errors. Consider lowering this provider in the fallback chain.` });
    }
  }

  for (const e of topErrors) {
    if (e.error_code === 'RATE_LIMITED' && e.count >= 5) {
      suggestions.push({ severity: 'medium', action: `${e.count} rate-limit events detected. Consider adding rate-limit backoff or switching to a higher-tier API plan.` });
    }
    if (e.error_code === 'AUTH_FAILURE' && e.count >= 3) {
      suggestions.push({ severity: 'high', action: `${e.count} auth failures detected. Check API keys in env vars or ~/.deepseek-key / ~/.qwen-key.` });
    }
    if (e.error_code === 'TIMEOUT' && e.count >= 5) {
      suggestions.push({ severity: 'medium', action: `${e.count} timeouts detected. Consider increasing --timeout-ms or checking network latency to provider APIs.` });
    }
  }

  return suggestions;
}

// ── Diagnose: deep-dive a specific run ──
export async function diagnoseRun(runId) {
  const entries = await readLog();
  const runEntries = entries.filter(e => e.run_id === runId);
  if (runEntries.length === 0) return { status: 'not_found', run_id: runId };

  const start = runEntries.find(e => e.event === 'run.start');
  const attempts = runEntries.filter(e => e.event === 'attempt.result');
  const verdict = runEntries.find(e => e.event === 'verdict');
  const error = runEntries.find(e => e.event === 'error');
  const fallbacks = runEntries.filter(e => e.event === 'fallback');

  const timeline = [...runEntries]
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .map(e => ({ ts: e.ts, event: e.event, detail: summarizeEvent(e) }));

  return {
    status: 'ok',
    run_id: runId,
    started: start?.ts,
    model: start?.model,
    lens: start?.lens,
    provider: start?.provider_pref,
    input_bytes: start?.input_bytes,
    attempts: attempts.map(a => ({
      provider: a.provider,
      model: a.model,
      outcome: a.outcome,
      duration_ms: a.duration_ms,
      reason_code: a.reason_code,
      tokens: a.tokens_used,
    })),
    fallbacks: fallbacks.map(f => ({ from: f.from_provider, to: f.to_provider, reason: f.reason })),
    verdict: verdict?.verdict,
    error: error?.error_code,
    timeline,
    root_cause: inferRootCause(attempts, fallbacks, error),
  };
}

function summarizeEvent(e) {
  switch (e.event) {
    case 'run.start': return `Model: ${e.model}, Lens: ${e.lens}, Provider: ${e.provider_pref}`;
    case 'attempt.start': return `${e.provider}/${e.model} starting`;
    case 'attempt.result': return `${e.outcome === 'success' ? 'OK' : 'FAIL'} ${e.provider}/${e.model} (${e.duration_ms}ms, ${e.reason_code})`;
    case 'fallback': return `Fallback ${e.from_provider}→${e.to_provider}: ${e.reason}`;
    case 'verdict': return `VERDICT: ${e.verdict} (${e.lens})`;
    case 'error': return `Terminal: ${e.error_code} after ${e.attempts_exhausted} attempts`;
    default: return e.event;
  }
}

function inferRootCause(attempts, fallbacks, error) {
  if (!error && attempts.every(a => a.outcome === 'success')) return 'All attempts succeeded.';

  const failedAttempts = attempts.filter(a => a.outcome === 'failed');
  if (failedAttempts.length === 0) {
    if (error) return `No successful attempts — terminal error: ${error.error_code}`;
    return 'Unknown failure pattern.';
  }

  const codes = failedAttempts.map(a => a.reason_code);
  const uniqueCodes = [...new Set(codes)];

  if (uniqueCodes.length === 1) {
    return `All failures share reason code: ${uniqueCodes[0]}. Single root cause — check provider status for this error.`;
  }

  if (uniqueCodes.includes('RATE_LIMITED') && uniqueCodes.includes('TIMEOUT')) {
    return 'Mixed rate-limit and timeout failures — possible network congestion or API overload. Increase timeout and check provider status.';
  }

  if (uniqueCodes.includes('AUTH_FAILURE')) {
    return 'Auth failure detected — check API key configuration.';
  }

  return `Multiple failure modes: ${uniqueCodes.join(', ')}. Providers may be experiencing degraded service.`;
}

// ── Expose log path for doctor/reporting ──
export function logPath() {
  return LOG_PATH;
}
