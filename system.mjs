// System health checks: dependencies, provider auth, API connectivity.
// Used by `ocask doctor` and `install.sh` for readiness assessment.
// All checks return { ok, label, detail } for structured reporting.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const MIN_NODE_MAJOR = 20;

// ── Check runner ──
async function run(name, fn) {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && typeof r.status === 'string') {
      const status = r.status;
      return {
        ok: status === 'pass',
        status,
        name,
        detail: typeof r.detail === 'string' ? r.detail : 'ok',
      };
    }
    if (r === false) return { ok: false, status: 'fail', name, detail: 'not configured' };
    return { ok: r !== false, status: r !== false ? 'pass' : 'fail', name, detail: r === false ? 'not configured' : (typeof r === 'string' ? r : (r?.detail || 'ok')) };
  } catch (e) {
    return { ok: false, status: 'fail', name, detail: e?.message || 'check failed' };
  }
}

// ── Dependency checks ──
function checkNodeVersion() {
  const v = process.version; // "v24.18.0"
  const major = parseInt(v.replace(/^v/, '').split('.')[0], 10);
  if (major >= MIN_NODE_MAJOR) return `Node.js ${v} (≥${MIN_NODE_MAJOR})`;
  return false; // fail
}

async function checkOpenCodeCli() {
  try {
    const bin = await findOnPath('opencode');
    const version = execSync(`"${bin}" --version`, { timeout: 5000 }).toString().trim();
    return `OpenCode CLI ${version} (${bin})`;
  } catch { return false; }
}

function checkDependencies() {
  const issues = [];
  if (!parseInt(process.version.replace(/^v/, '').split('.')[0], 10) >= MIN_NODE_MAJOR) {
    issues.push(`Node.js ≥ ${MIN_NODE_MAJOR} required (got ${process.version})`);
  }
  return { ok: issues.length === 0, issues };
}

// ── Provider auth checks ──
async function checkKeyFile(filepath, label) {
  const p = filepath.startsWith('/') ? filepath : path.join(os.homedir(), filepath);
  try {
    const stat = await fs.lstat(p);
    if (stat.isSymbolicLink()) return false;
    if (!stat.isFile()) return false;
    const mode = stat.mode & 0o777;
    if (mode !== 0o600 && mode !== 0o400) return `key file ${p} has permissive mode ${mode.toString(8)} (need 0600)`;
    const content = (await fs.readFile(p, 'utf8')).trim();
    if (!content) return false;
    if (content.length < 10) return `key file too short (${content.length} chars)`;
    return `${label} key file OK (${content.length} chars)`;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    return `cannot read key file: ${e.message}`;
  }
}

async function checkProviderAuth(provider) {
  switch (provider) {
    case 'deepseek': {
      const env = process.env.DEEPSEEK_API_KEY;
      if (env) return env.length >= 10 ? 'DEEPSEEK_API_KEY set' : 'DEEPSEEK_API_KEY too short';
      return checkKeyFile('.deepseek-key', 'DeepSeek');
    }
    case 'qwen': {
      const env = process.env.QWEN_API_KEY;
      if (env) return env.length >= 10 ? 'QWEN_API_KEY set' : 'QWEN_API_KEY too short';
      return checkKeyFile('.qwen-key', 'Qwen');
    }
    case 'opencode': {
      const bin = await findOnPath('opencode');
      if (bin) return `OpenCode CLI found at ${bin}`;
      return false;
    }
    default: return false;
  }
}

export function locusFromStatus(httpStatus) {
  if (!Number.isInteger(httpStatus)) return null;
  if (httpStatus >= 200 && httpStatus < 300) return null;
  // 402 Payment Required is a billing/entitlement signal — the provider's account/entitlement
  // system, i.e. their-side. This keeps status-derived locus consistent with classifyFailure,
  // which classes ENTITLEMENT_UNAVAILABLE / INSUFFICIENT_BALANCE as their-side (#21). It stays
  // distinct from the 4xx→our-side default (401/403/429 auth/rate are our config/usage side).
  if (httpStatus === 402) return 'their-side';
  if (httpStatus >= 400 && httpStatus <= 499) return 'our-side';
  if (httpStatus >= 500 && httpStatus <= 599) return 'their-side';
  return null;
}

export function connectivityStatusFromHttp(httpStatus, trialed = false) {
  if (!Number.isInteger(httpStatus)) return { status: 'fail', locus: null, reason: 'unreachable' };
  const locus = locusFromStatus(httpStatus);
  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: trialed ? 'pass' : 'warn', locus: null, reason: 'reachable; usability unverified (ping only)' };
  }
  return { status: 'warn', locus, reason: `reachable but ${httpStatus}` };
}

// ── API connectivity probe ──
async function probeEndpoint(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const start = Date.now();
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    const latency = Date.now() - start;
    const state = connectivityStatusFromHttp(res.status, false);
    return { status: state.status, locus: state.locus, detail: `${label}: ${res.status} (${latency}ms); ${state.reason}` };
  } catch (e) {
    return { status: 'fail', detail: e.name === 'AbortError' ? `${label}: timeout` : `${label}: ${e.message}`, locus: null };
  } finally { clearTimeout(timer); }
}

async function checkApiConnectivity(provider) {
  switch (provider) {
    case 'deepseek': return probeEndpoint('https://api.deepseek.com/v1/models', 'DeepSeek API');
    case 'qwen': return probeEndpoint('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', 'Qwen API');
    case 'opencode': return 'OpenCode CLI (local, no API probe)';
    default: return 'unknown provider';
  }
}

// ── PATH helper ──
async function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try { await fs.access(cand, fsSync.constants.X_OK); return cand; } catch { /* continue */ }
  }
  return null;
}

// Roll a check list into a tri-state summary. Every check maps to EXACTLY one of
// pass/warn/fail — an explicit `status` if present, else derived from `ok` — so
// `pass + warn + fail === total` holds even for checks pushed directly (not via run()),
// and per-category counts use the same derivation. Overall: any fail → unhealthy;
// else any warn → degraded; else healthy.
export function summarizeChecks(checks) {
  const effStatus = (c) => c.status || (c.ok ? 'pass' : 'fail');
  const ok = checks.filter(c => c.ok).length;
  const total = checks.length;
  const pass = checks.filter(c => effStatus(c) === 'pass').length;
  const warn = checks.filter(c => effStatus(c) === 'warn').length;
  const fail = checks.filter(c => effStatus(c) === 'fail').length;
  const categories = {};
  for (const c of checks) {
    if (!categories[c.category]) categories[c.category] = { ok: 0, total: 0, status: { pass: 0, warn: 0, fail: 0 } };
    categories[c.category].total++;
    if (c.ok) categories[c.category].ok++;
    categories[c.category].status[effStatus(c)] += 1;
  }
  let status = 'healthy';
  if (fail > 0) status = 'unhealthy';
  else if (warn > 0) status = 'degraded';
  return { status, summary: { ok, total, pass, warn, fail, categories, by_status: { pass, warn, fail } } };
}

// ── Full system health report ──
export async function systemHealth() {
  const checks = [];

  // Dependencies
  checks.push({ category: 'dependencies', ...await run('node', checkNodeVersion) });
  checks.push({ category: 'dependencies', ...await run('opencode-cli', checkOpenCodeCli) });

  // Provider auth
  for (const p of ['deepseek', 'qwen', 'opencode']) {
    checks.push({ category: 'auth', ...await run(`${p}-auth`, () => checkProviderAuth(p)) });
  }

  // Connectivity
  for (const p of ['deepseek', 'qwen']) {
    checks.push({ category: 'connectivity', ...await run(`${p}-connectivity`, () => checkApiConnectivity(p)) });
  }

  // Log health
  try {
    const logDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'ocask');
    const logPath = path.join(logDir, 'log.jsonl');
    const stat = await fs.stat(logPath).catch(() => null);
    checks.push({ category: 'data', name: 'log-file', ok: true, status: 'pass', detail: stat ? `${(stat.size / 1024).toFixed(1)} KB` : 'no log yet' });
  } catch {
    checks.push({ category: 'data', name: 'log-file', ok: true, status: 'pass', detail: 'no log yet' });
  }

  const { status, summary } = summarizeChecks(checks);
  return { status, checks, summary };
}

// ── Formatting ──
export function formatSystemHealth(report) {
  const lines = [`ocask system health: ${report.status.toUpperCase()}`];
  lines.push('');
  let lastCat = '';
  const statusTag = {
    pass: 'pass',
    warn: 'warn',
    fail: 'fail',
  };
  for (const c of report.checks) {
    if (c.category !== lastCat) { lines.push(`  ${c.category}:`); lastCat = c.category; }
    const st = c.status || (c.ok ? 'pass' : 'fail');
    lines.push(`    ${statusTag[st] || 'fail'} ${c.name}: ${c.detail}`);
  }
  lines.push('');
  lines.push(`  ${report.summary.pass}/${report.summary.total} checks passed`);
  lines.push(`  ${report.summary.warn} checks warn, ${report.summary.fail} checks fail`);
  for (const [cat, s] of Object.entries(report.summary.categories)) {
    const passCount = s.status?.pass || 0;
    const warnCount = s.status?.warn || 0;
    const failCount = s.status?.fail || 0;
    lines.push(`  ${cat}: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);
  }
  return lines.join('\n');
}

// ── Dependency check for install.sh ──
export { checkDependencies };
