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
  try { const r = await fn(); return { ok: r !== false, name, detail: r === false ? 'not configured' : (typeof r === 'string' ? r : (r?.detail || 'ok')) }; }
  catch (e) { return { ok: false, name, detail: e?.message || 'check failed' }; }
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

// ── API connectivity probe ──
async function probeEndpoint(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const start = Date.now();
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    const latency = Date.now() - start;
    if (!res.ok) return `${label}: ${res.status} (${latency}ms)`;
    return `${label}: reachable (${latency}ms)`;
  } catch (e) {
    return e.name === 'AbortError' ? `${label}: timeout` : `${label}: ${e.message}`;
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
    checks.push({ category: 'data', name: 'log-file', ok: true, detail: stat ? `${(stat.size / 1024).toFixed(1)} KB` : 'no log yet' });
  } catch {
    checks.push({ category: 'data', name: 'log-file', ok: true, detail: 'no log yet' });
  }

  const ok = checks.filter(c => c.ok).length;
  const total = checks.length;
  const categories = {};
  for (const c of checks) {
    if (!categories[c.category]) categories[c.category] = { ok: 0, total: 0 };
    categories[c.category].total++;
    if (c.ok) categories[c.category].ok++;
  }

  return {
    status: ok === total ? 'healthy' : ok > total * 0.5 ? 'degraded' : 'unhealthy',
    checks,
    summary: { ok, total, categories },
  };
}

// ── Formatting ──
export function formatSystemHealth(report) {
  const lines = [`ocask system health: ${report.status.toUpperCase()}`];
  lines.push('');
  let lastCat = '';
  for (const c of report.checks) {
    if (c.category !== lastCat) { lines.push(`  ${c.category}:`); lastCat = c.category; }
    const mark = c.ok ? '✓' : '✗';
    lines.push(`    ${mark} ${c.name}: ${c.detail}`);
  }
  lines.push('');
  lines.push(`  ${report.summary.ok}/${report.summary.total} checks passed`);
  for (const [cat, s] of Object.entries(report.summary.categories)) {
    lines.push(`  ${cat}: ${s.ok}/${s.total}`);
  }
  return lines.join('\n');
}

// ── Dependency check for install.sh ──
export { checkDependencies };
