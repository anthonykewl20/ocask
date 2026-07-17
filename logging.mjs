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
  try {
    const raw = await fs.readFile(LOG_PATH, 'utf8');
    const lines = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (since && new Date(entry.ts) < new Date(since)) continue;
        if (until && new Date(entry.ts) > new Date(until)) continue;
        lines.push(entry);
      } catch { /* skip malformed — log is resilient to partial writes */ }
    }
    return limit ? lines.slice(-limit) : lines;
  } catch { return []; }
}

export async function doctorReport(options = {}) {
  const entries = await readLog(options);
  const sysHealth = options.system !== false ? await (async () => {
    try { const { systemHealth: sh } = await import('./system.mjs'); return await sh(); } catch { return null; }
  })() : null;

  if (entries.length === 0 && !sysHealth) return { status: 'empty', message: 'No log entries or system data. Run ocask first.' };

  // ── Build run records ──
  const runs = {};
  for (const e of entries) {
    const rid = e.run_id;
    if (!rid) continue;
    if (e.event === 'run.start') {
      runs[rid] = { model: e.model, lens: e.lens, provider: e.provider_pref, started: e.ts,
        attempts: [], verdict: null, error: null, inputBytes: e.input_bytes, timeoutMs: e.timeout_ms };
    }
    if (e.event === 'attempt.result') {
      if (runs[rid]) runs[rid].attempts.push(e);
    }
    if (e.event === 'verdict' && runs[rid]) runs[rid].verdict = e.verdict;
    if (e.event === 'error' && runs[rid]) runs[rid].error = e.error_code;
    if (e.event === 'cross.verify' && runs[rid]) runs[rid].crossVerify = e;
  }

  // ── Aggregate stats ──
  const providerStats = {}; // key: provider/model
  const modelStats = {};    // key: model
  const perDay = {};        // key: YYYY-MM-DD

  for (const e of entries) {
    if (e.event !== 'attempt.result') continue;
    const pkey = `${e.provider}/${e.model}`;
    if (!providerStats[pkey]) providerStats[pkey] = { total: 0, success: 0, errors: {}, totalMs: 0, tokens: 0 };
    providerStats[pkey].total++;
    providerStats[pkey].totalMs += e.duration_ms || 0;
    providerStats[pkey].tokens += (e.tokens_used?.total || e.tokens_used || 0);
    if (e.outcome === 'success') providerStats[pkey].success++;
    else providerStats[pkey].errors[e.reason_code || 'unknown'] = (providerStats[pkey].errors[e.reason_code || 'unknown'] || 0) + 1;

    if (!modelStats[e.model]) modelStats[e.model] = { total: 0, success: 0, totalMs: 0, tokens: 0 };
    modelStats[e.model].total++;
    modelStats[e.model].totalMs += e.duration_ms || 0;
    modelStats[e.model].tokens += (e.tokens_used?.total || e.tokens_used || 0);
    if (e.outcome === 'success') modelStats[e.model].success++;
    else { modelStats[e.model][`err_${e.reason_code || 'unknown'}`] = (modelStats[e.model][`err_${e.reason_code || 'unknown'}`] || 0) + 1; }

    const day = (e.ts || '').slice(0, 10);
    if (!perDay[day]) perDay[day] = { total: 0, success: 0, tokens: 0 };
    perDay[day].total++;
    perDay[day].tokens += (e.tokens_used?.total || e.tokens_used || 0);
    if (e.outcome === 'success') perDay[day].success++;
  }

  const totalRuns = Object.keys(runs).length;
  const successfulRuns = Object.values(runs).filter(r => r.verdict && !r.error).length;
  const failedRuns = Object.values(runs).filter(r => r.error).length;
  const partialRuns = Object.values(runs).filter(r => !r.verdict && !r.error).length; // crashed mid-flight
  const verdictDist = { APPROVED: 0, WARNING: 0, BLOCKED: 0 };
  for (const r of Object.values(runs)) { if (r.verdict && verdictDist[r.verdict] !== undefined) verdictDist[r.verdict]++; }

  // ── Flake detection ──
  const flakes = [];
  for (const [rid, run] of Object.entries(runs)) {
    const att = run.attempts || [];
    for (let i = 0; i < att.length - 1; i++) {
      if (att[i].outcome === 'failed' && att[i + 1].outcome === 'success') {
        flakes.push({ run_id: rid, flaky_provider: att[i].provider, flaky_model: att[i].model,
          error_code: att[i].reason_code, recovered_by: att[i + 1].provider, recovered_model: att[i + 1].model });
      }
    }
  }

  // ── Provider summary ──
  const providers = Object.entries(providerStats).map(([key, s]) => ({
    provider_model: key,
    total: s.total, success: s.success,
    success_rate: s.total > 0 ? (s.success / s.total * 100).toFixed(1) + '%' : 'N/A',
    avg_latency_ms: s.total > 0 ? Math.round(s.totalMs / s.total) : 0,
    error_breakdown: s.errors, total_tokens: s.tokens,
  })).sort((a, b) => b.total - a.total);

  // ── Model summary ──
  const models = Object.entries(modelStats).map(([key, s]) => ({
    model: key,
    total: s.total, success: s.success,
    success_rate: s.total > 0 ? (s.success / s.total * 100).toFixed(1) + '%' : 'N/A',
    avg_latency_ms: s.total > 0 ? Math.round(s.totalMs / s.total) : 0,
    total_tokens: s.tokens,
  })).sort((a, b) => b.total - a.total);

  // ── Trend: per-day success rate ──
  const trend = Object.entries(perDay).sort().map(([day, d]) => ({
    date: day,
    total: d.total,
    success_rate: d.total > 0 ? (d.success / d.total * 100).toFixed(1) + '%' : 'N/A',
    tokens: d.tokens,
  }));

  // ── Top errors ──
  const errorCounts = {};
  for (const [, s] of Object.entries(providerStats)) {
    for (const [code, count] of Object.entries(s.errors)) {
      errorCounts[code] = (errorCounts[code] || 0) + count;
    }
  }
  const topErrors = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([code, count]) => ({ error_code: code, count }));

  // ── Total cost estimate ──
  const totalTokens = Object.values(providerStats).reduce((s, p) => s + p.tokens, 0);

  const dateRange = entries.length > 0
    ? `${(entries[0].ts || '').slice(0, 10)} → ${(entries[entries.length - 1].ts || '').slice(0, 10)}`
    : 'N/A';

  return {
    status: 'ok',
    summary: { total_runs: totalRuns, successful: successfulRuns, failed: failedRuns,
      partial_crashes: partialRuns, verdict_distribution: verdictDist,
      total_tokens: totalTokens, date_range: dateRange },
    providers,
    models,
    trend,
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
    if (rate < 50 && p.total >= 1 && p.total - p.success > 0) {
      const codes = Object.keys(p.error_breakdown || {});
      const isAuth = codes.includes('AUTH_FAILURE');
      const isTimeout = codes.includes('TIMEOUT');
      const isExhausted = codes.includes('all_exhausted') || codes.includes('OPencode_EXHAUSTED');

      if (isTimeout && p.avg_latency_ms > 20000) {
        suggestions.push({
          severity: 'medium',
          action: `Provider ${p.provider_model}: ${p.total - p.success} timeout(s) at ${p.avg_latency_ms}ms avg. Increase --timeout-ms or check network.`,
        });
      } else if (isExhausted && !isAuth) {
        suggestions.push({
          severity: 'high',
          action: `Provider ${p.provider_model}: ${p.total - p.success} exhausted/failures. OpenCode Go may be out of credits — check https://opencode.ai/account.`,
        });
      } else if (isAuth || isExhausted) {
        suggestions.push({
          severity: 'high',
          action: `Provider ${p.provider_model}: ${rate}% success. Auth/config issue. Check credentials or use --provider flag.`,
        });
      } else if (p.total >= 3) {
        suggestions.push({
          severity: 'high',
          action: `Provider ${p.provider_model}: ${rate}% success over ${p.total} attempts. Consider removing from fallback chain.`,
        });
      }
    }
    if (p.avg_latency_ms > 30000) {
      suggestions.push({ severity: 'medium', action: `Provider ${p.provider_model} avg latency ${p.avg_latency_ms}ms. Increase --timeout-ms or switch.` });
    }
  }

  // Config mismatch: one provider has auth failures, another works fine
  const working = providers.filter(p => parseFloat(p.success_rate) >= 50 && p.total >= 1).map(p => p.provider_model);
  const failing = providers.filter(p => parseFloat(p.success_rate) === 0 && p.total >= 1).map(p => p.provider_model);
  if (failing.length > 0 && working.length > 0) {
    for (const f of failing) {
      suggestions.push({
        severity: 'high',
        action: `${f} fails but ${working.join(', ')} works. config mismatch: add API key for ${f} or use --provider ${working[0].split('/')[0]}.`,
      });
    }
  }

  // Flake detection — lower threshold to 1
  const flakeByProvider = {};
  for (const f of flakes) {
    const key = `${f.flaky_provider}/${f.flaky_model}`;
    flakeByProvider[key] = (flakeByProvider[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(flakeByProvider)) {
    if (count >= 1) {
      suggestions.push({
        severity: 'medium',
        action: `Flaky provider: ${key} failed (${flakes.find(f => `${f.flaky_provider}/${f.flaky_model}` === key)?.error_code}) then recovered ${count} time(s).`,
      });
    }
  }

  // Lower thresholds for immediate feedback
  for (const e of topErrors) {
    if (e.error_code === 'RATE_LIMITED' && e.count >= 1) {
      suggestions.push({ severity: 'medium', action: `${e.count} rate-limit(s). Check API plan limits.` });
    }
    if (e.error_code === 'AUTH_FAILURE' && e.count >= 1) {
      suggestions.push({ severity: 'high', action: `${e.count} auth failure(s). Check API keys.` });
    }
    if (e.error_code === 'TIMEOUT' && e.count >= 2) {
      suggestions.push({ severity: 'medium', action: `${e.count} timeout(s). Increase --timeout-ms or check connectivity.` });
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
  const crossVerify = runEntries.find(e => e.event === 'cross.verify');

  // Sort entries by timestamp for timeline
  const sorted = [...runEntries].sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));
  const firstTs = sorted[0]?.ts ? new Date(sorted[0].ts).getTime() : 0;
  const timeline = sorted.map(e => ({
    ts: e.ts, event: e.event, relative_ms: firstTs ? new Date(e.ts).getTime() - firstTs : 0,
    detail: _summarizeEvent(e),
  }));

  // Compute total wall-clock duration
  const lastTs = sorted[sorted.length - 1]?.ts ? new Date(sorted[sorted.length - 1].ts).getTime() : 0;
  const totalDurationMs = lastTs - firstTs;

  // Token usage
  const tokensUsed = attempts.reduce((acc, a) => {
    const t = a.tokens_used || {};
    return { input: acc.input + (t.input || 0), output: acc.output + (t.output || 0), total: acc.total + (t.total || 0) };
  }, { input: 0, output: 0, total: 0 });

  const attemptSummary = attempts.map(a => ({
    index: a.attempt_index,
    provider: a.provider,
    model: a.model,
    outcome: a.outcome,
    duration_ms: a.duration_ms,
    reason_code: a.reason_code,
    error_class: a.error_class,
    tokens: a.tokens_used,
  }));

  // Root cause inference with fix suggestions
  const rootCause = _inferRootCause(attempts, fallbacks, error, start);

  return {
    status: 'ok', run_id: runId,
    started: start?.ts, total_duration_ms: totalDurationMs,
    model: start?.model, lens: start?.lens, provider_pref: start?.provider_pref,
    input_bytes: start?.inputBytes || start?.input_bytes,
    timeout_ms: start?.timeoutMs || start?.timeout_ms,
    attempts: attemptSummary,
    fallbacks: fallbacks.map(f => ({ from: `${f.from_provider}/${f.from_model}`, to: `${f.to_provider}/${f.to_model}`, reason: f.reason })),
    verdict: verdict?.verdict,
    error: error?.error_code,
    cross_verify: crossVerify ? { agreement: crossVerify.agreement, primary: crossVerify.primary_verdict, buddy: crossVerify.buddy_verdict } : null,
    tokens: tokensUsed,
    timeline,
    root_cause: rootCause.cause,
    fix: rootCause.fix,
  };
}

function _summarizeEvent(e) {
  switch (e.event) {
    case 'run.start': return `${e.model} | lens=${e.lens} | provider=${e.provider_pref} | ${e.input_bytes || e.input_bytes}B`;
    case 'attempt.result': return `${e.outcome === 'success' ? '✓' : '✗'} ${e.provider}/${e.model} ${e.duration_ms}ms [${e.reason_code}]`;
    case 'fallback': return `${e.from_model}→${e.to_model}: ${e.reason}`;
    case 'verdict': return `VERDICT: ${e.verdict}`;
    case 'error': return `TERMINAL: ${e.error_code} (${e.attempts_exhausted} attempts)`;
    case 'cross.verify': return `Cross-verify: ${e.agreement ? 'AGREE' : 'DISAGREE'} (primary=${e.primary_verdict}, buddy=${e.buddy_verdict})`;
    default: return e.event;
  }
}

function _inferRootCause(attempts, fallbacks, error, start) {
  if (!error && attempts.every(a => a.outcome === 'success')) {
    return { cause: 'All attempts succeeded — no failure.', fix: null };
  }

  const failed = attempts.filter(a => a.outcome === 'failed');
  if (failed.length === 0) {
    return {
      cause: error ? `Terminal error without failed attempts: ${error.error_code}` : 'Unknown failure pattern.',
      fix: 'Run ocask with --timeout-ms to capture timeout details.',
    };
  }

  const codes = [...new Set(failed.map(a => a.reason_code))];

  if (codes.includes('AUTH_FAILURE') || codes.includes('all_exhausted') || codes.includes('OPencode_EXHAUSTED')) {
    const missing = failed.find(a => a.provider !== 'unknown' && a.provider !== 'opencode');
    const worksVia = attempts.find(a => a.outcome === 'success');
    if (worksVia) {
      return {
        cause: `${failed[0].provider}/${failed[0].model}: auth/config failure. The opencode provider works — API keys for native providers not configured.`,
        fix: `Use --provider ${worksVia.provider} or set ${failed[0].provider?.toUpperCase()}_API_KEY.`,
      };
    }
    return {
      cause: `Provider ${failed[0].provider} failed: no credentials configured.`,
      fix: `Set ${failed[0].provider?.toUpperCase()}_API_KEY env var, create ~/.${failed[0].provider}-key file, or use --provider opencode.`,
    };
  }

  if (codes.includes('RATE_LIMITED')) {
    return { cause: 'Provider rate-limited. API quota exhausted or request volume too high.', fix: 'Check API plan limits, add billing, or switch provider.' };
  }

  if (codes.includes('TIMEOUT')) {
    return { cause: `Request timed out after ${start?.timeoutMs || 'unknown'}ms.`, fix: 'Increase --timeout-ms, check network latency, or switch provider.' };
  }

  if (codes.includes('MALFORMED_RESPONSE')) {
    return { cause: 'Provider returned unparseable response.', fix: 'Retry with --no-fallback false to enable opposite-family fallback.' };
  }

  if (codes.includes('ENTITLEMENT_UNAVAILABLE')) {
    return { cause: 'API key classified as Lite tier — paid models unavailable.', fix: 'Upgrade API key or use a different provider.' };
  }

  return {
    cause: `Multiple failure modes: ${codes.join(', ')}.`,
    fix: 'Check provider status. Run ocask doctor for health overview.',
  };
}

// ── Expose log path for doctor/reporting ──
export function logPath() {
  return LOG_PATH;
}
