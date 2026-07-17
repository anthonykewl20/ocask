// OpenCode CLI provider — delegates to `opencode run --pure`.
// Supports both direct one-shot mode and optional persistent-server attach.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';
import { isPaidModelAllowed } from '../ocverify.mjs';
import { isDeepSeekModel, isQwenModel, ProviderError } from './factory.mjs';

const MAX_OUTPUT_BYTES = 0;
const KILL_GRACE_MS = 1000;
const SERVER_START_WAIT_MS = 15000;
const SERVER_HEALTH_TIMEOUT_MS = 1000;
const SERVER_POLL_MS = 50;
const SERVER_LOCK_STALE_MS = 30000;
const SERVER_STATE_VERSION = 2;

const CHILD_ENV = Object.freeze({
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_PERMISSION: '{"*":"allow"}',
});

const ACTIVE_SIGNAL_TERMINATORS = new Set();
const HOST_SIGNAL_HANDLERS = new Map();

function registerSignalTerminator(terminator) {
  if (ACTIVE_SIGNAL_TERMINATORS.size === 0) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => { for (const active of [...ACTIVE_SIGNAL_TERMINATORS]) active(signal); };
      HOST_SIGNAL_HANDLERS.set(signal, handler);
      process.on(signal, handler);
    }
  }
  ACTIVE_SIGNAL_TERMINATORS.add(terminator);
  return () => {
    ACTIVE_SIGNAL_TERMINATORS.delete(terminator);
    if (ACTIVE_SIGNAL_TERMINATORS.size === 0) {
      for (const [signal, handler] of HOST_SIGNAL_HANDLERS) process.off(signal, handler);
      HOST_SIGNAL_HANDLERS.clear();
    }
  };
}

function resolveOnPath(name, envPath) {
  for (const d of String(envPath || '').split(':')) {
    if (!d) continue;
    const cand = path.join(d, name);
    try {
      const st = fsSync.statSync(cand);
      if (st.isFile()) { fsSync.accessSync(cand, fsSync.constants.X_OK); return cand; }
    } catch { /* not here */ }
  }
  return null;
}

function makeError(message, code) {
  return Object.assign(new ProviderError(message, code), { code });
}

function defaultRuntimeDir(env = process.env) {
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'ocask');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `ocask-${uid}`);
}

async function ensurePrivateRuntimeDir(runtimeDir) {
  await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(runtimeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw makeError('runtime path not a private dir', 'SERVER_SETUP');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw makeError('runtime dir not user-owned', 'SERVER_SETUP');
  await fs.promises.chmod(runtimeDir, 0o700);
}

function statePaths(runtimeDir) {
  return { statePath: path.join(runtimeDir, 'server-state.json'), lockPath: path.join(runtimeDir, 'server-start.lock') };
}

function validServerState(state) {
  return state?.schema === SERVER_STATE_VERSION && Number.isInteger(state.pid) && state.pid > 0
    && Number.isInteger(state.port) && state.port > 0 && state.port < 65536
    && typeof state.password === 'string' && state.password.length >= 32
    && typeof state.version === 'string' && state.version.length > 0;
}

async function readServerState(runtimeDir) {
  const { statePath: sp } = statePaths(runtimeDir);
  try {
    const stat = await fs.promises.lstat(sp);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    const state = JSON.parse(await fs.promises.readFile(sp, 'utf8'));
    return validServerState(state) ? state : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function basicAuth(password) { return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`; }

async function probeServerHealth(state, { fetchImpl = fetch, pidAliveImpl = isPidAlive, healthTimeoutMs = SERVER_HEALTH_TIMEOUT_MS } = {}) {
  if (!state || !pidAliveImpl(state.pid)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${state.port}/global/health`, {
      headers: { Authorization: basicAuth(state.password) }, signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload?.healthy !== true || typeof payload.version !== 'string' || !payload.version) return null;
    if (state.version && payload.version !== state.version) return null;
    return { version: payload.version };
  } catch { return null; } finally { clearTimeout(timer); }
}

async function healthyStoredServer(runtimeDir, options) {
  const { statePath: sp } = statePaths(runtimeDir);
  let state = await readServerState(runtimeDir);
  if (!state) {
    try { await fs.promises.lstat(sp); state = await readServerState(runtimeDir); if (!state) throw makeError('invalid persistent server state', 'SERVER_SETUP'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }
  const health = await probeServerHealth(state, options);
  if (!health) {
    if (options.pidAliveImpl(state.pid)) throw makeError('recorded server alive but unhealthy', 'SERVER_SETUP');
    await fs.promises.rm(sp, { force: true });
    return null;
  }
  return { ...state, url: `http://127.0.0.1:${state.port}`, cold: false };
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port || 0;
      server.close((error) => { if (error) reject(error); else if (!port) reject(makeError('no loopback port', 'SERVER_SETUP')); else resolve(port); });
    });
  });
}

function launchPersistentServer({ port, password, runtimeDir, env, opencodeBin, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    if (!path.isAbsolute(opencodeBin || '')) { reject(makeError('absolute opencode bin required', 'SERVER_SETUP')); return; }
    let child;
    try { child = spawnImpl(opencodeBin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: runtimeDir, env: { ...env, ...CHILD_ENV, OPENCODE_SERVER_PASSWORD: password }, shell: false, detached: process.platform !== 'win32', stdio: 'ignore' }); }
    catch (error) { reject(makeError(`opencode serve spawn failed: ${error?.message}`, 'SERVER_SETUP')); return; }
    child.once('error', (error) => reject(makeError(`opencode serve error: ${error?.message}`, 'SERVER_SETUP')));
    child.once('spawn', () => { child.unref(); resolve({ pid: child.pid }); });
  });
}

async function ensurePersistentServer(opts = {}) {
  const runtimeDir = opts.runtimeDir || defaultRuntimeDir();
  const inheritedEnv = opts.inheritedEnv || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const pidAliveImpl = opts.pidAliveImpl || isPidAlive;
  const reservePortImpl = opts.reservePortImpl || reserveLoopbackPort;
  const serverLauncher = opts.serverLauncher || launchPersistentServer;
  const randomBytesImpl = opts.randomBytesImpl || randomBytes;
  const sleepImpl = opts.sleepImpl || ((ms) => new Promise(r => setTimeout(r, ms)));
  const nowImpl = opts.nowImpl || Date.now;
  const startWaitMs = opts.startWaitMs || SERVER_START_WAIT_MS;
  const pollMs = opts.pollMs || SERVER_POLL_MS;
  const opencodeBin = opts.opencodeBin || resolveOnPath('opencode', inheritedEnv.PATH);

  if (!path.isAbsolute(opencodeBin || '')) throw makeError('opencode not found on PATH', 'ENOENT');
  await ensurePrivateRuntimeDir(runtimeDir);
  const healthOptions = { fetchImpl, pidAliveImpl };
  const existing = await healthyStoredServer(runtimeDir, healthOptions);
  if (existing) return existing;

  const { lockPath } = statePaths(runtimeDir);
  const deadline = nowImpl() + startWaitMs;
  let lockHandle = null;

  while (!lockHandle) {
    try {
      lockHandle = await fs.promises.open(lockPath, 'wx', 0o600);
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: nowImpl() })}\n`);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const shared = await healthyStoredServer(runtimeDir, healthOptions);
      if (shared) return shared;
      if (await removeStaleLock(lockPath, { nowImpl, pidAliveImpl })) continue;
      if (nowImpl() >= deadline) throw makeError('timed out waiting for server start', 'SERVER_SETUP');
      await sleepImpl(pollMs);
    }
  }

  let launched = null;
  try {
    const raced = await healthyStoredServer(runtimeDir, healthOptions);
    if (raced) return raced;
    const port = await reservePortImpl();
    const password = randomBytesImpl(32).toString('base64url');
    launched = await serverLauncher({ port, password, runtimeDir, env: inheritedEnv, opencodeBin });
    if (!Number.isInteger(launched?.pid) || launched.pid <= 0) throw makeError('no valid server pid', 'SERVER_SETUP');

    const candidate = { pid: launched.pid, port, password };
    while (nowImpl() < deadline) {
      const health = await probeServerHealth(candidate, healthOptions);
      if (health) {
        const state = { schema: SERVER_STATE_VERSION, ...candidate, version: health.version, startedAt: new Date(nowImpl()).toISOString() };
        await writeServerState(runtimeDir, state, randomBytesImpl);
        return { ...state, url: `http://127.0.0.1:${port}`, cold: true };
      }
      await sleepImpl(pollMs);
    }
    throw makeError('server health check failed', 'SERVER_SETUP');
  } catch (error) {
    if (launched?.pid) signalPidTree(launched.pid, 'SIGTERM');
    throw error;
  } finally {
    await lockHandle.close();
    await fs.promises.rm(lockPath, { force: true });
  }
}

async function removeStaleLock(lockPath, { nowImpl, pidAliveImpl }) {
  try {
    const stat = await fs.promises.stat(lockPath);
    if (nowImpl() - stat.mtimeMs < SERVER_LOCK_STALE_MS) return false;
    let owner; try { owner = JSON.parse(await fs.promises.readFile(lockPath, 'utf8')); } catch { owner = null; }
    if (owner?.pid && pidAliveImpl(owner.pid)) return false;
    await fs.promises.rm(lockPath, { force: true });
    return true;
  } catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

async function writeServerState(runtimeDir, state, randomBytesImpl = randomBytes) {
  const { statePath: sp } = statePaths(runtimeDir);
  const suffix = randomBytesImpl(8).toString('hex');
  const tempPath = path.join(runtimeDir, `server-state.${process.pid}.${suffix}.tmp`);
  await fs.promises.writeFile(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
  try { await fs.promises.rename(tempPath, sp); await fs.promises.chmod(sp, 0o600); }
  catch (error) { await fs.promises.rm(tempPath, { force: true }); throw error; }
}

function signalPidTree(pid, signal) {
  try { if (process.platform !== 'win32') process.kill(-pid, signal); else process.kill(pid, signal); } catch { /* already exited */ }
}

function signalChildTree(child, signal) {
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try { process.kill(-child.pid, signal); return; } catch (error) { if (error?.code !== 'ESRCH') { /* fall through */ } }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

function runBoundedCommand({ command, args, prompt, cwd, env, timeoutMs, maxOutputBytes = MAX_OUTPUT_BYTES, spawnImpl = spawn, killGraceMs = KILL_GRACE_MS }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(makeError(`spawn ${command}: ${error?.message}`, error?.code || 'SPAWN')); return; }

    const stdoutChunks = [], stderrChunks = [];
    let stdoutBytes = 0, stderrBytes = 0, settled = false, forcedError = null, killTimer = null, timeoutTimer = null;
    let unregisterSignals = () => {};

    const finish = (cb) => { if (settled) return; settled = true; clearTimeout(timeoutTimer); clearTimeout(killTimer); unregisterSignals(); cb(); };
    const terminate = (error) => { if (forcedError || settled) return; forcedError = error; signalChildTree(child, 'SIGTERM'); killTimer = setTimeout(() => signalChildTree(child, 'SIGKILL'), killGraceMs); };
    unregisterSignals = registerSignalTerminator((signal) => { terminate(makeError(`${command} interrupted by ${signal}`, 'INTERRUPTED')); });

    const collect = (chunks, kind) => (chunk) => {
      const buffer = Buffer.from(chunk);
      if (kind === 'stdout') stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      if (maxOutputBytes > 0 && (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes)) { terminate(makeError(`${kind} output limit exceeded`, 'OUTPUT_LIMIT')); return; }
      chunks.push(buffer);
    };

    child.stdout.on('data', collect(stdoutChunks, 'stdout'));
    child.stderr.on('data', collect(stderrChunks, 'stderr'));
    child.stdin.on('error', () => {});

    child.once('error', (error) => {
      const msg = error?.code === 'ENOENT' ? `${command} not found on PATH` : `spawn ${command}: ${error?.message}`;
      finish(() => reject(makeError(msg, 'SPAWN')));
    });

    child.once('close', (code, signal) => {
      finish(() => {
        if (forcedError) { reject(forcedError); return; }
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code !== 0) reject(makeError(`${command} exit ${code}${signal ? ` (${signal})` : ''}`, 'PROCESS_EXIT'));
        else resolve({ stdout, stderr });
      });
    });

    if (timeoutMs > 0) timeoutTimer = setTimeout(() => terminate(makeError(`${command} timed out after ${timeoutMs}ms`, 'TIMEOUT')), timeoutMs);
    child.stdin.end(prompt, 'utf8');
  });
}

const MAX_PLAUSIBLE_PATH_LENGTH = 4096;

// Extract token usage from opencode JSONL output
function extractOpenCodeTokens(stdout) {
  if (!stdout) return null;
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === 'step_finish' && e.part?.tokens) {
        return { input: e.part.tokens.input || 0, output: e.part.tokens.output || 0, total: e.part.tokens.total || 0 };
      }
    } catch { /* skip */ }
  }
  return null;
}

// Detect silent exhaustion: exit 0 but no usable text output
function _hasTextEvent(stdout) {
  if (!stdout) return false;
  for (const line of stdout.split('\n')) {
    try { const e = JSON.parse(line); if (e?.type === 'text' && e.part?.type === 'text' && typeof e.part?.text === 'string') return true; }
    catch { /* skip */ }
  }
  return false;
}

export async function invoke({ model, prompt, timeoutMs = 0, env = process.env, cwd = process.cwd() }) {
  if (!isPaidModelAllowed(model)) throw makeError(`Model ${model} is not allowed`, 'MODEL_NOT_ALLOWED');

  const opencodeBin = resolveOnPath('opencode', env.PATH);
  if (!opencodeBin) throw makeError('OpenCode CLI not found on PATH', 'ENOENT');

  const disableServer = env.OCASK_DISABLE_SERVER !== '0';
  const providerPrefix = isDeepSeekModel(model) ? 'deepseek' : (isQwenModel(model) ? 'alibaba' : 'deepseek');
  const isDeepSeek = isDeepSeekModel(model);

  const args = [
    'run', '--auto', '--pure',
    '--model', `${providerPrefix}/${model}`,
    '--format', 'json',
    ...(isDeepSeek ? ['--variant', 'max'] : []),
  ];

  const childEnv = {
    ...env,
    ...CHILD_ENV,
    AI_FLOW_LEAF: '1',
    AI_FLOW_TRACE: randomBytes(16).toString('hex'),
  };

  try {
    const result = await runBoundedCommand({
      command: opencodeBin,
      args,
      prompt,
      cwd,
      env: childEnv,
      timeoutMs,
    });
    const tokens = extractOpenCodeTokens(result.stdout);
    // Detect silent exhaustion: exit 0 but no usable text output
    if (!result.stdout || !_hasTextEvent(result.stdout)) {
      throw makeError(`opencode produced no usable text output (exhausted/quota/empty response). Check OpenCode Go balance at https://opencode.ai/account.`, 'OPencode_EXHAUSTED');
    }
    return { stdout: result.stdout, stderr: result.stderr, provider: 'opencode', model_used: model, tokensUsed: tokens };
  } catch (error) {
    if (error?.code === 'OPencode_EXHAUSTED') throw error;
    if (error?.code === 'TIMEOUT') throw makeError(`opencode timed out after ${timeoutMs}ms`, 'TIMEOUT');
    if (error?.code === 'PROCESS_EXIT') throw makeError('opencode CLI exited with error', 'PROVIDER_ERROR');
    throw error;
  }
}
