// Structured observability: JSONL append-only log for invocation tracing,
// provider health, flake detection, and diagnostic analysis.
// Log path: XDG_DATA_HOME/ocask/log.jsonl (~/.local/share/ocask/log.jsonl)

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB before rotation
const ROTATION_KEEP = 2; // keep this many rotated files

// Resolve the log location at CALL time (not import time) so the path reflects
// the live XDG_DATA_HOME — this lets tests redirect the log to a temp dir and
// keeps logPath() honest if the environment shifts between processes.
function logDir() {
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'ocask'
  );
}
export function logPath() {
  return path.join(logDir(), 'log.jsonl');
}

// ── Init ──
async function ensureLogDir() {
  await fs.mkdir(logDir(), { recursive: true, mode: 0o700 });
}

// ── Failure-record taxonomy (#2) + contract (#3) ──
// A failure record must let the cause be recovered from the log line ALONE — no
// inference at read time. The provider factory wraps every terminal failure as
// ALL_PROVIDERS_EXHAUSTED, keeping the real error as `.cause`. classifyFailure
// UNWRAPS to the originating cause and classifies THAT, so the reported
// `mechanism` is always the true code (never the wrapper). `all_exhausted` is
// retired as a classifier output; ALL_PROVIDERS_EXHAUSTED remains an internal
// wrapper code only.

// Originating codes whose failure is on the provider's side of the wire.
const _THEIR_SIDE = new Set([
  'TIMEOUT', 'RATE_LIMITED', 'CONNECTION_ERROR', 'ENTITLEMENT_UNAVAILABLE',
  'PROVIDER_ERROR', 'INSUFFICIENT_BALANCE', 'MALFORMED_RESPONSE', 'OPencode_EXHAUSTED',
]);
// Originating codes whose failure is on our side (config / environment / our gate).
const _OUR_SIDE = new Set([
  'AUTH_FAILURE', 'PROVIDER_UNAVAILABLE', 'NO_PROVIDER', 'MODEL_NOT_FOUND',
  'MODEL_NOT_ALLOWED', 'ENOENT', 'SPAWN', 'SERVER_SETUP', 'OUTPUT_LIMIT',
]);
// Originating codes where the model replied but the reply was unusable.
const _REPLY_UNUSABLE = new Set(['MODEL_OUTPUT', 'VERDICT_PARSE', 'VERDICT_VALIDATE']);

// Peel the factory's ALL_PROVIDERS_EXHAUSTED wrapper iteratively (in case of
// nesting) to reach the originating cause. Stops at the first non-wrapper node so
// it never drills past a real ProviderError into that error's own internal cause.
export function unwrapOrigin(error) {
  let node = error;
  let guard = 0;
  while (node && node.code === 'ALL_PROVIDERS_EXHAUSTED' && node.cause && guard++ < 32) {
    node = node.cause;
  }
  return node || error;
}

// Classify an attempt outcome into the failure-record taxonomy.
//   classifyFailure(error)                         → failure (no-judgment + mechanism)
//   classifyFailure(null, { verdict: 'APPROVED' }) → judgment (validated verdict)
// `error` may be factory-wrapped; it is unwrapped before classification.
export function classifyFailure(error, opts = {}) {
  const verdict = opts.verdict;
  if (verdict === 'APPROVED' || verdict === 'WARNING' || verdict === 'BLOCKED') {
    // A judgment is emitted ONLY when a model demonstrably judged the code.
    return { class: 'judgment', subclass: null, locus: null, mechanism: null,
      censored: false, http_status: null, retry_after: null };
  }

  const origin = unwrapOrigin(error);
  const mechanism = origin?.code || null;
  const httpStatus = Number.isInteger(origin?.status) ? origin.status : null;
  const retryAfter = origin?.retryAfter != null ? origin.retryAfter : null;

  // Fail-safe defaults: anything not positively a validated verdict is
  // no-judgment; anything unclassifiable is the loud `indeterminate` residual.
  let subclass = 'indeterminate';
  let locus = null;
  if (_REPLY_UNUSABLE.has(mechanism)) {
    subclass = 'reply-unusable';
  } else if (_THEIR_SIDE.has(mechanism)) {
    subclass = 'reply-absent'; locus = 'their-side';
  } else if (_OUR_SIDE.has(mechanism)) {
    subclass = 'reply-absent'; locus = 'our-side';
  }

  return {
    class: 'no-judgment',
    subclass,
    locus,
    mechanism,
    censored: mechanism === 'TIMEOUT',
    http_status: httpStatus,
    retry_after: retryAfter,
  };
}

// Spread a classification into the snake_case record fields written to the log.
function _classificationFields(c) {
  if (!c) return null;
  const fields = {
    class: c.class,
    subclass: c.subclass ?? null,
    locus: c.locus ?? null,
    mechanism: c.mechanism ?? null,
    duration_censored: Boolean(c.censored),
  };
  if (c.http_status != null) fields.http_status = c.http_status;
  if (c.retry_after != null) fields.retry_after = c.retry_after;
  return fields;
}

export function locusFromStatus(httpStatus) {
  if (!Number.isInteger(httpStatus)) return null;
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) return 'our-side';
  if (httpStatus >= 500 && httpStatus <= 599) return 'their-side';
  if (httpStatus >= 200 && httpStatus < 300) return null;
  if (httpStatus >= 300 && httpStatus <= 599) return 'their-side';
  return null;
}

export function _safeObservation({ provider, model, mechanism, className, subclass, locus, httpStatus }) {
  const parts = [
    provider ? `provider=${provider}` : 'provider=unknown',
    model ? `model=${model}` : 'model=unknown',
    `mechanism=${mechanism ?? 'unknown'}`,
    `class=${className ?? 'unknown'}`,
    `subclass=${subclass ?? 'unknown'}`,
    `locus=${locus ?? 'unknown'}`,
    `http_status=${httpStatus ?? 'n/a'}`,
  ];
  return parts.join(', ');
}

function _percentile(values, q) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b).filter(n => Number.isFinite(n));
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function _inferFailureFinding(attempt, baselineHealthyP99Ms = null, options = {}) {
  const provider = attempt.provider;
  const isOpencode = provider === 'opencode';
  const mechanism = attempt.mechanism || null;
  const durationMs = attempt.duration_ms != null ? Number(attempt.duration_ms) : null;
  const timedOut = mechanism === 'TIMEOUT';
  const durationCensored = Boolean(attempt.duration_censored);
  const providerLabel = (provider || 'unknown').toUpperCase();

  const observation = {
    provider,
    model: attempt.model,
    className: attempt.class,
    mechanism,
    subclass: attempt.subclass,
    locus: attempt.locus,
    httpStatus: attempt.http_status,
  };
  const symptom = _safeObservation(observation);

  const fallbackAction = `Observed symptom: ${symptom}.`;

  if (!mechanism) {
    return { cause: 'undetermined', fix: fallbackAction };
  }

  switch (mechanism) {
    case 'AUTH_FAILURE': {
      if (attempt.locus && attempt.locus !== 'our-side') return { cause: 'undetermined', fix: fallbackAction };
      return {
        cause: `${provider || 'unknown'}: auth/config failure (our-side).`,
        fix: isOpencode
          ? `Ensure OpenCode CLI is installed and operational for ${provider || 'that provider'}.`
          : `Set ${providerLabel}_API_KEY or use --provider with another configured provider.`,
      };
    }
    case 'RATE_LIMITED':
      return {
        cause: `${provider || 'unknown'}: rate-limited (our-side).`,
        fix: 'Back off, reduce concurrency, or check API plan limits.',
      };
    case 'ENTITLEMENT_UNAVAILABLE':
    case 'INSUFFICIENT_BALANCE':
      if (options.requireExplicitEntitlement && attempt.mechanism !== 'ENTITLEMENT_UNAVAILABLE' && attempt.http_status !== 402) {
        return { cause: 'undetermined', fix: fallbackAction };
      }
      return {
        cause: `${provider || 'unknown'}: billing/quota issue for this provider.`,
        fix: `Check ${provider || 'that provider'} billing/quota and enable sufficient credits.`,
      };
    case 'TIMEOUT': {
      const p99 = baselineHealthyP99Ms;
      if (timedOut && durationCensored && Number.isFinite(durationMs) && p99 && durationMs >= 2 * p99) {
        return {
          cause: `${provider || 'unknown'}: likely HANG (their-side).`,
          fix: `Do NOT increase --timeout-ms. Investigate stuck call timing, payload size, and downstream hangs before retrying.`,
        };
      }
      if (timedOut) {
        return {
          cause: `${provider || 'unknown'}: deadline exceeded (their-side).`,
          fix: `Increase --timeout-ms or hedge with a fallback provider.`,
        };
      }
      return { cause: 'undetermined', fix: fallbackAction };
    }
    default:
      return { cause: 'undetermined', fix: fallbackAction };
  }
}

// ── Rotation ──
async function maybeRotate() {
  const LOG_PATH = logPath();
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
  const LOG_PATH = logPath();
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
  timeoutMs = 0, reasonCode, outputBytes, tokensUsed, errorClass, classification = null }) {
  const record = {
    run_id: _currentRunId,
    provider,
    model,
    attempt_index: attemptIndex,
    outcome,
    duration_ms: durationMs,
    timeout_ms: timeoutMs || 0,
    reason_code: reasonCode || 'ok',
    output_bytes: outputBytes || 0,
    tokens_used: tokensUsed,
    error_class: errorClass || null,
  };
  // Failure-record taxonomy (#2/#3): class/subclass/locus/mechanism/censored/...
  const cf = _classificationFields(classification);
  if (cf) Object.assign(record, cf);
  await logEvent('attempt.result', record);
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

export async function logError({ model, provider, errorCode, errorClass, attemptCount, durationMs,
  timeoutMs = 0, classification = null }) {
  const record = {
    run_id: _currentRunId,
    model,
    provider,
    error_code: errorCode,
    error_class: errorClass,
    attempts_exhausted: attemptCount,
    duration_ms: durationMs,
    timeout_ms: timeoutMs || 0,
  };
  // Failure-record taxonomy (#2/#3): the true mechanism + class/subclass/locus.
  const cf = _classificationFields(classification);
  if (cf) Object.assign(record, cf);
  await logEvent('error', record);
}

export function currentRunId() {
  return _currentRunId;
}

// ── Doctor: read and analyze the log ──
export async function readLog(options = {}) {
  const { since, until, limit } = options;
  const LOG_PATH = logPath();
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
    if (!providerStats[pkey]) providerStats[pkey] = {
      total: 0,
      success: 0,
      errorBreakdown: {},
      latencyMsTotal: 0,
      latencySamples: [],
      successLatencySamples: [],
      tokens: 0,
      failureBuckets: {},
    };
    providerStats[pkey].total++;
    const durationMs = Number(e.duration_ms) || 0;
    const durationCensored = Boolean(e.duration_censored);
    if (durationMs > 0 && !durationCensored) {
      providerStats[pkey].latencySamples.push(durationMs);
      providerStats[pkey].latencyMsTotal += durationMs;
      if (e.outcome === 'success') providerStats[pkey].successLatencySamples.push(durationMs);
    }
    providerStats[pkey].tokens += (e.tokens_used?.total || e.tokens_used || 0);
    if (e.outcome === 'success') providerStats[pkey].success++;
    else {
      const evidence = e.mechanism || e.reason_code || 'unknown';
      providerStats[pkey].errorBreakdown[evidence] = (providerStats[pkey].errorBreakdown[evidence] || 0) + 1;
      const locus = e.locus ?? locusFromStatus(Number.isInteger(e.http_status) ? e.http_status : null);
      const bucketKey = `${e.provider || 'unknown'}|${e.model || 'unknown'}|${e.mechanism || 'unknown'}|${locus || 'unknown'}`;
      if (!providerStats[pkey].failureBuckets[bucketKey]) {
        providerStats[pkey].failureBuckets[bucketKey] = {
          provider: e.provider,
          model: e.model,
          mechanism: e.mechanism || e.reason_code || 'unknown',
          class: e.class ?? null,
          subclass: e.subclass ?? null,
          locus: locus ?? null,
          http_status: e.http_status ?? null,
          count: 0,
          maxDurationMs: null,
          avgDurationMs: null,
          durationSamples: [],
          durationCensored: 0,
          evidenceCount: 0,
        };
      }
      const bucket = providerStats[pkey].failureBuckets[bucketKey];
      bucket.count++;
      bucket.evidenceCount++;
      if (durationMs > 0) {
        bucket.durationSamples.push(durationMs);
        bucket.avgDurationMs = Math.round(bucket.durationSamples.reduce((s, v) => s + v, 0) / bucket.durationSamples.length);
        if (bucket.maxDurationMs == null || durationMs > bucket.maxDurationMs) bucket.maxDurationMs = durationMs;
      }
      if (durationCensored) bucket.durationCensored++;
    }

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
    avg_latency_ms: s.latencySamples.length > 0 ? Math.round(s.latencyMsTotal / s.latencySamples.length) : 0,
    total_tokens: s.tokens,
    error_breakdown: s.errorBreakdown,
    failure_buckets: Object.values(s.failureBuckets),
    failure_counts: Object.keys(s.failureBuckets).length,
    healthy_p99_ms: _percentile(s.successLatencySamples, 0.99),
    uncensored_latency_count: s.latencySamples.length,
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
    for (const [code, count] of Object.entries(s.errorBreakdown)) {
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
    suggestions: generateSuggestions(providers, flakes),
    system: sysHealth,
  };
}

export function generateSuggestions(providers, flakes) {
  const suggestions = [];

  for (const p of providers) {
    const failureBuckets = p.failure_buckets || [];
    if (failureBuckets.length === 0) continue;
    for (const failure of failureBuckets) {
      // The bucket aggregates duration as maxDurationMs + a censored COUNT; map those to the
      // per-attempt shape _inferFailureFinding reads so the hang branch (censored + ≫P99) is
      // reachable from the doctor path, not only from diagnoseRun. Max duration = worst case.
      const finding = _inferFailureFinding(
        { ...failure, duration_ms: failure.maxDurationMs, duration_censored: failure.durationCensored > 0 },
        p.healthy_p99_ms,
        { requireExplicitEntitlement: true },
      );
      const observation = _safeObservation({
        provider: failure.provider,
        model: failure.model,
        mechanism: failure.mechanism,
        className: failure.class,
        subclass: failure.subclass,
        locus: failure.locus,
        httpStatus: failure.http_status,
      });
      const countText = `${failure.count}x`;
      if (finding.cause === 'undetermined') {
        const already = `Observed: ${observation}`;
        if (failure.mechanism === 'AUTH_FAILURE') {
          suggestions.push({
            severity: 'high',
            action: `Provider ${p.provider_model}: undetermined (${countText}). ${already}. ${finding.fix}`,
          });
        } else {
          suggestions.push({
            severity: 'medium',
            action: `Provider ${p.provider_model}: undetermined (${countText}). ${already}. ${finding.fix}`,
          });
        }
      } else {
        const severity = failure.mechanism === 'TIMEOUT' || failure.mechanism === 'AUTH_FAILURE'
          ? 'high'
          : (finding.cause.includes('billing/quota') ? 'high' : 'medium');
        suggestions.push({
          severity,
          action: `Provider ${p.provider_model}: ${countText} ${finding.cause} ${finding.fix}`,
        });
      }
    }

    if (p.uncensored_latency_count > 0 && p.avg_latency_ms > 30000) {
      suggestions.push({
        severity: 'medium',
        action: `Provider ${p.provider_model}: uncensored avg latency ${p.avg_latency_ms}ms. Consider increasing timeout or provider hedge.`,
      });
    }

    // Config mismatch: one provider has no successful run while another has 1+ success.
    const works = providers.filter(other => parseFloat(other.success_rate) >= 50 && other.total >= 1).map(other => other.provider_model);
    if (parseFloat(p.success_rate) === 0 && works.length > 0) {
      const replacement = works.find(other => other !== p.provider_model);
      if (replacement) {
        suggestions.push({
          severity: 'high',
          action: `${p.provider_model} fails while ${replacement} works. Check provider config and credentials for ${p.provider_model}.`,
        });
      }
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
    duration_censored: Boolean(a.duration_censored),
    reason_code: a.reason_code,
    mechanism: a.mechanism,
    error_class: a.error_class,
    class: a.class ?? null,
    subclass: a.subclass ?? null,
    locus: a.locus ?? null,
    http_status: a.http_status ?? null,
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

export function _inferRootCause(attempts, fallbacks, error, start) {
  if (!error && attempts.every(a => a.outcome === 'success')) {
    return { cause: 'All attempts succeeded — no failure.', fix: null };
  }

  const failed = attempts.filter(a => a.outcome === 'failed');
  const successDurations = attempts
    .filter(a => a.outcome === 'success' && !a.duration_censored)
    .map(a => Number(a.duration_ms))
    .filter(Number.isFinite);
  const healthyP99Ms = _percentile(successDurations, 0.99);

  if (failed.length === 0) {
    return {
      cause: error ? `Terminal error without failed attempts: ${error.error_code}` : 'Unknown failure pattern.',
      fix: 'Run ocask with --timeout-ms to capture timeout details.',
    };
  }

  const signatures = new Map();
  for (const attempt of failed) {
    const mechanism = attempt.mechanism || attempt.reason_code || 'unknown';
    const locus = attempt.locus ?? locusFromStatus(Number.isInteger(attempt.http_status) ? attempt.http_status : null);
    const key = `${attempt.provider || 'unknown'}|${attempt.model || 'unknown'}|${mechanism}|${locus || 'unknown'}`;
    if (!signatures.has(key)) {
      signatures.set(key, {
        provider: attempt.provider,
        model: attempt.model,
        mechanism,
        class: attempt.class ?? null,
        subclass: attempt.subclass ?? null,
        locus,
        http_status: attempt.http_status ?? null,
        duration_ms: Number(attempt.duration_ms),
        duration_censored: Boolean(attempt.duration_censored),
      });
    }
  }

  const observations = [...signatures.values()];
  if (observations.length > 1) {
    return {
      cause: 'undetermined',
      fix: `Observed: ${observations.map(_safeObservation).join(' | ')}`,
    };
  }

  const [observation] = observations;
  const result = _inferFailureFinding(observation, healthyP99Ms, { requireExplicitEntitlement: true });
  if (result.cause === 'undetermined') {
    return { cause: 'undetermined', fix: `Observed: ${_safeObservation(observation)}` };
  }

  return result;
}
