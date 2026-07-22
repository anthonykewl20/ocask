import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildPrompt,
  buildJsonResponse,
  classifyDiffInput,
  computeConsensus,
  defaultFallbackModel,
  detectRisk,
  describeOutcome,
  exitCodeForOutcome,
  extractJsonObject,
  extractVerdict,
  guardAllowedModels,
  parseArgs,
  parseOpenCodeJsonl,
  promptHash,
  readExistingPathOrLiteral,
  remainingBudget,
  resolvePanelMembers,
  resolveRisk,
  runAsk,
  runMain,
  runPanel,
  selectPanel,
  resolveTimeout,
  validateAssistantOutput,
} from './ocask.mjs';
import {
  classifyFailure,
  generateSuggestions,
  doctorReport,
  _inferRootCause,
  locusFromStatus,
  logAttemptResult,
  unwrapOrigin,
  readLog,
  startRun,
  scrubMessage,
  MAX_MECHANISM_MSG_LENGTH,
} from './logging.mjs';
import {
  ProviderError,
  isIdentityPreservingTransport,
  identityTransportRoute,
  identityTransportTrustTable,
  invokeWithFallback,
  resolveProviderChain,
} from './providers/factory.mjs';
import { connectivityStatusFromHttp, summarizeChecks } from './system.mjs';

const QWEN_MODEL = 'qwen3.7-plus';
const QWEN_MAX_MODEL = 'qwen3.7-max';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_PRO_MODEL = 'deepseek-v4-pro';

async function makeFakeOpenCodeCli(mode = 'success') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-identity-'));
  const binDir = path.join(root, 'bin');
  const homeDir = path.join(root, 'home');
  const tracePath = path.join(root, 'opencode-args.json');
  const promptTracePath = path.join(root, 'opencode-prompts.json');
  const metadataPath = path.join(root, 'metadata.json');
  const ocaskPath = path.join(root, 'ocask');
  await fs.mkdir(binDir);
  await fs.mkdir(homeDir);
  const executable = path.join(binDir, 'opencode');
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OCASK_TEST_OPENCODE_TRACE, JSON.stringify(args) + '\\n');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => fs.appendFileSync(process.env.OCASK_TEST_OPENCODE_PROMPT_TRACE, JSON.stringify(prompt) + '\\n'));
const route = args[args.indexOf('--model') + 1];
if (process.env.OCASK_TEST_OPENCODE_MODE.startsWith('swap-') && route.startsWith('deepseek/')) {
  process.stdout.write(JSON.stringify({type:'text', timestamp:Date.now(), part:{type:'text', text:JSON.stringify({reason:'Primary deliberately omitted its verdict.'})}}) + '\\n');
} else if (process.env.OCASK_TEST_OPENCODE_MODE === 'swap-failure' && route.startsWith('alibaba/')) {
  process.stderr.write('controlled qwen transport failure\\n');
  process.exitCode = 1;
} else if (process.env.OCASK_TEST_OPENCODE_MODE === 'slow') {
  setTimeout(() => process.stdout.write(JSON.stringify({type:'text', timestamp:Date.now(), part:{type:'text', text:JSON.stringify({verdict:'APPROVED', reason:'Late response.'})}}) + '\\n'), 1000);
} else if (process.env.OCASK_TEST_OPENCODE_MODE === 'retry-recovers' && route.startsWith('deepseek/')) {
  // #45: first same-model attempt omits the verdict (MODEL_OUTPUT); the retry recovers it.
  const attempts = fs.readFileSync(process.env.OCASK_TEST_OPENCODE_TRACE, 'utf8').trim().split('\\n').filter(Boolean).length;
  if (attempts <= 1) {
    process.stdout.write(JSON.stringify({type:'text', timestamp:Date.now(), part:{type:'text', text:JSON.stringify({reason:'Primary omitted its verdict.'})}}) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({type:'text', timestamp:Date.now(), part:{type:'text', text:JSON.stringify({verdict:'BLOCKED', reason:'Recovered on same-model retry.'})}}) + '\\n');
  }
} else if (process.env.OCASK_TEST_OPENCODE_MODE === 'cross' && route.startsWith('deepseek/')) {
  process.stdout.write(JSON.stringify({type:'text', timestamp:Date.now(), part:{type:'text', text:'VERDICT: APPROVED\\n\\nRationale: buddy concurs.'}}) + '\\n');
} else if (process.env.OCASK_TEST_OPENCODE_MODE === 'blocked') {
  process.stdout.write(JSON.stringify({type:'text', timestamp:Date.now(), part:{type:'text', text:JSON.stringify({verdict:'BLOCKED', reason:'Controlled blocking finding.'})}}) + '\\n');
} else if (process.env.OCASK_TEST_OPENCODE_MODE === 'failure') {
  process.stderr.write('controlled provider failure\\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({type:'text', timestamp:Date.now(), part:{type:'text', text:JSON.stringify({verdict:'APPROVED', reason:'Real factory path reached OpenCode.'})}}) + '\\n');
}
`);
  await fs.chmod(executable, 0o755);
  await fs.symlink(fileURLToPath(new URL('ocask.mjs', import.meta.url)), ocaskPath);
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    XDG_DATA_HOME: path.join(root, 'data'),
    OCASK_DISABLE_SERVER: '1',
    OCASK_TEST_OPENCODE_TRACE: tracePath,
    OCASK_TEST_OPENCODE_PROMPT_TRACE: promptTracePath,
    OCASK_TEST_OPENCODE_MODE: mode,
    DEEPSEEK_API_KEY: '',
    QWEN_API_KEY: '',
  };
  return { root, tracePath, promptTracePath, metadataPath, ocaskPath, env };
}

async function readOpenCodeTrace(tracePath) {
  return (await fs.readFile(tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

async function readOpenCodePrompts(promptTracePath) {
  return (await fs.readFile(promptTracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

// ── Arg parsing ──
test('parseArgs handles supported booleans and rejects unknown legacy flags', () => {
  const args = parseArgs(['--model', QWEN_MODEL, '--task', 'audit', '--json', '--require-verdict', '--no-fallback']);
  assert.equal(args.model, QWEN_MODEL);
  assert.equal(args.task, 'audit');
  assert.equal(args.json, true);
  assert.equal(args['require-verdict'], true);
  assert.equal(args['no-fallback'], true);
});

// ── Risk-based panel selection ──
test('classifyDiffInput recognizes git and unified diffs without treating prose as a diff', () => {
  assert.equal(classifyDiffInput(''), 'empty');
  assert.equal(classifyDiffInput('Review the auth module carefully.'), 'prose');
  assert.equal(classifyDiffInput('diff --git a/readme.md b/readme.md\n@@ -1 +1 @@\n-old\n+new'), 'diff');
  assert.equal(classifyDiffInput('--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-old\n+new'), 'diff');
});

test('detectRisk classifies tiny, ordinary, large, and sensitive-path diffs', () => {
  const tiny = 'diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-old\n+new';
  const ordinary = `diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1 +1,16 @@\n-old\n${Array.from({ length: 16 }, (_, i) => `+line ${i}`).join('\n')}`;
  const large = `diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -0,0 +1,401 @@\n${Array.from({ length: 401 }, (_, i) => `+line ${i}`).join('\n')}`;
  const sensitive = 'diff --git a/src/auth/session.mjs b/src/auth/session.mjs\n--- a/src/auth/session.mjs\n+++ b/src/auth/session.mjs\n@@ -1 +1 @@\n-old\n+new';
  assert.equal(detectRisk(tiny), 'trivial');
  assert.equal(detectRisk(ordinary), 'default');
  assert.equal(detectRisk(large), 'high');
  assert.equal(detectRisk(sensitive), 'high');
});

test('resolveRisk auto-detects diffs and conservatively defaults prose or empty context', () => {
  const tiny = '--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-old\n+new';
  assert.equal(resolveRisk({ risk: 'auto', contextText: tiny }), 'trivial');
  assert.equal(resolveRisk({ risk: 'auto', contextText: 'Review this module.' }), 'default');
  assert.equal(resolveRisk({ risk: 'auto', contextText: '' }), 'default');
  assert.equal(resolveRisk({ risk: 'high', contextText: tiny }), 'high');
  assert.throws(() => resolveRisk({ risk: 'extreme' }), /Unsupported risk: extreme/);
});

test('selectPanel maps trivial to solo and default/high to strict cross-family K=2 panels', () => {
  const trivial = selectPanel('trivial', { model: DEEPSEEK_PRO_MODEL });
  assert.equal(trivial.mode, 'solo');
  assert.deepEqual(trivial.members, [DEEPSEEK_PRO_MODEL]);
  assert.equal(trivial.k, null);

  for (const risk of ['default', 'high']) {
    const selection = selectPanel(risk, { model: DEEPSEEK_PRO_MODEL });
    assert.equal(selection.mode, 'panel');
    assert.deepEqual(selection.members.map(member => member.model), [DEEPSEEK_PRO_MODEL, QWEN_MODEL]);
    assert.deepEqual(selection.members.map(member => member.family), ['deepseek', 'qwen']);
    assert.equal(selection.k, 2);
    assert.equal(selection.noFallback, risk === 'high');
    assert.equal(selection.strict, risk === 'high');
    if (risk === 'high') {
      const trustTable = identityTransportTrustTable();
      assert.ok(selection.members.every(member => Object.hasOwn(trustTable, member.model)));
      assert.ok(selection.members.every(member => member.provider_chain.includes('opencode')));
      assert.ok(selection.members.every(member => isIdentityPreservingTransport(member.model, 'opencode')));
    }
  }
  assert.throws(() => selectPanel('extreme', { model: DEEPSEEK_PRO_MODEL }), /Unsupported risk: extreme/);
});

// ── Model gate ──
test('paid-model gate rejects free and unknown models', () => {
  assert.throws(() => guardAllowedModels({ model: 'deepseek-v4-free' }), /not allowed/);
  assert.throws(() => guardAllowedModels({ model: 'gpt-4o' }), /not allowed/);
  guardAllowedModels({ model: DEEPSEEK_PRO_MODEL });
});

test('default fallback is deterministic and from opposite family', () => {
  assert.equal(defaultFallbackModel(DEEPSEEK_MODEL), 'qwen3.7-max');
  assert.equal(defaultFallbackModel('qwen3.7-max'), DEEPSEEK_PRO_MODEL);
});

// ── Verify panel (#23) ──
test('resolvePanelMembers selects the exact trust-table-supported default panel', () => {
  const members = resolvePanelMembers({
    model: DEEPSEEK_PRO_MODEL,
    noFallback: false,
    preferredProvider: 'opencode',
    env: process.env,
  });
  assert.deepEqual(members.map(member => member.model), [DEEPSEEK_PRO_MODEL, QWEN_MODEL]);
  assert.ok(!members.some(member => member.model === QWEN_MAX_MODEL));
  assert.ok(members.every(member => Object.hasOwn(identityTransportTrustTable(), member.model)));
  assert.deepEqual(members.map(member => member.family), ['deepseek', 'qwen']);
  assert.deepEqual(members.map(member => member.transport), ['opencode', 'opencode']);
  assert.equal(new Set(members.map(member => member.family)).size, 2);
});

test('resolvePanelMembers fails fast when a member has no serving transport', () => {
  assert.throws(
    () => resolvePanelMembers({
      model: DEEPSEEK_PRO_MODEL,
      noFallback: false,
      preferredProvider: 'deepseek',
      env: process.env,
    }),
    /Panel member qwen3\.7-plus has no available serving transport/,
  );
});

test('resolvePanelMembers --no-fallback admits only identity-preserving transports', () => {
  const members = resolvePanelMembers({ model: DEEPSEEK_PRO_MODEL, noFallback: true, env: process.env });
  assert.equal(members.length, 2);
  for (const member of members) {
    assert.ok(member.provider_chain.length > 0);
    assert.ok(member.provider_chain.every(transport => isIdentityPreservingTransport(member.model, transport)));
  }
});

const panelJudgment = (model, verdict) => ({
  model,
  verdict,
  classification: classifyFailure(null, { verdict }),
});
const panelAbstention = (model, mechanism = 'TIMEOUT') => ({
  model,
  verdict: null,
  classification: classifyFailure(Object.assign(new ProviderError(mechanism, mechanism), { code: mechanism })),
});

test('computeConsensus returns unanimous APPROVED and counts only real judgments', () => {
  const consensus = computeConsensus({
    memberResults: [panelJudgment(DEEPSEEK_PRO_MODEL, 'APPROVED'), panelJudgment(QWEN_MAX_MODEL, 'APPROVED')],
    k: 2,
  });
  assert.equal(consensus.consensus_verdict, 'APPROVED');
  assert.equal(consensus.agreement, true);
  assert.equal(consensus.judgments_count, 2);
  assert.equal(consensus.abstentions_count, 0);
  assert.equal(consensus.degraded, false);
});

test('computeConsensus uses conservative WARNING/BLOCKED split tiebreakers', () => {
  const warning = computeConsensus({
    memberResults: [panelJudgment(DEEPSEEK_PRO_MODEL, 'APPROVED'), panelJudgment(QWEN_MAX_MODEL, 'WARNING')],
    k: 2,
  });
  assert.equal(warning.consensus_verdict, 'WARNING');
  assert.equal(warning.agreement, false);

  const blocked = computeConsensus({
    memberResults: [panelJudgment(DEEPSEEK_PRO_MODEL, 'APPROVED'), panelJudgment(QWEN_MAX_MODEL, 'BLOCKED')],
    k: 2,
  });
  assert.equal(blocked.consensus_verdict, 'BLOCKED');
  assert.equal(blocked.agreement, false);
});

test('computeConsensus never turns all abstentions into a verdict or agreement', () => {
  const consensus = computeConsensus({
    memberResults: [panelAbstention(DEEPSEEK_PRO_MODEL), panelAbstention(QWEN_MAX_MODEL, 'AUTH_FAILURE')],
    k: 2,
  });
  assert.equal(consensus.consensus_verdict, null);
  assert.equal(consensus.agreement, false);
  assert.equal(consensus.judgments_count, 0);
  assert.equal(consensus.abstentions_count, 2);
  assert.equal(consensus.degraded, true);
});

test('computeConsensus returns quorum failure when one of two members abstains', () => {
  const consensus = computeConsensus({
    memberResults: [panelJudgment(DEEPSEEK_PRO_MODEL, 'APPROVED'), panelAbstention(QWEN_MAX_MODEL)],
    k: 2,
  });
  assert.equal(consensus.consensus_verdict, null);
  assert.equal(consensus.agreement, false);
  assert.equal(consensus.judgments_count, 1);
  assert.equal(consensus.abstentions_count, 1);
  assert.equal(consensus.degraded, true);
  assert.equal(consensus.member_verdicts[1].verdict, null);
});

test('runPanel launches members in parallel with one shared absolute deadline', async () => {
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const absoluteDeadlineMs = Date.now() + 1000;
  const result = await runPanel({
    model: DEEPSEEK_PRO_MODEL,
    taskText: 'Review.',
    requireVerdict: true,
    provider: 'opencode',
    timeoutMs: 1000,
    absoluteDeadlineMs,
    run_id: 'panel-parallel-test',
    invokeWithFallbackFn: async ({ model, timeoutMs }) => {
      calls.push({ model, timeoutMs, startedAt: Date.now() });
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active--;
      return { provider: 'opencode', model_used: model, commandOutput: 'VERDICT: APPROVED\n\nRationale: ok.' };
    },
  });
  assert.equal(maxActive, 2, 'both panel members must overlap');
  assert.deepEqual(new Set(calls.map(call => call.model)), new Set([DEEPSEEK_PRO_MODEL, QWEN_MODEL]));
  assert.ok(calls.every(call => call.timeoutMs > 0 && call.timeoutMs <= 1000));
  assert.ok(calls.every(call => call.startedAt + call.timeoutMs <= absoluteDeadlineMs + 5));
  assert.equal(result.verdict, 'APPROVED');
  assert.equal(result.consensus.judgments_count, 2);
});

test('runPanel uses review hard ceiling when timeout exceeds delegation ceiling', async () => {
  const calls = [];
  const result = await runPanel({
    model: DEEPSEEK_PRO_MODEL,
    taskText: 'Review.',
    requireVerdict: true,
    provider: 'opencode',
    timeoutMs: 1_000_000,
    run_id: 'panel-ops-ceiling-test',
    invokeWithFallbackFn: async ({ model, timeoutMs }) => {
      calls.push(timeoutMs);
      return { provider: 'opencode', model_used: model, commandOutput: 'VERDICT: APPROVED\n\nRationale: enough evidence.' };
    },
  });
  assert.equal(result.verdict, 'APPROVED');
  assert.ok(calls.every(timeoutMs => timeoutMs > 300000 && timeoutMs <= 900000),
    `panel members must inherit review ceiling for timeout budgeting (${calls.join(', ')})`);
});

test('runPanel classifies one member timeout as an abstention and fails K=2 quorum', async () => {
  const result = await runPanel({
    model: DEEPSEEK_PRO_MODEL,
    taskText: 'Review.',
    requireVerdict: true,
    provider: 'opencode',
    timeoutMs: 1000,
    absoluteDeadlineMs: Date.now() + 1000,
    run_id: 'panel-abstention-test',
    invokeWithFallbackFn: async ({ model }) => {
      if (model === QWEN_MODEL) throw Object.assign(new ProviderError('timed out', 'TIMEOUT'), { code: 'TIMEOUT', provider: 'opencode' });
      return { provider: 'opencode', model_used: model, commandOutput: 'VERDICT: APPROVED\n\nRationale: ok.' };
    },
  });
  assert.equal(result.verdict, null);
  assert.equal(result.failed, true);
  assert.equal(result.classification.mechanism, 'PANEL_QUORUM_FAILURE');
  assert.equal(result.consensus.judgments_count, 1);
  assert.equal(result.consensus.abstentions_count, 1);
  assert.equal(result.members.find(member => member.model === QWEN_MODEL).classification.class, 'no-judgment');
});

test('runPanel fails fast on a preferred provider incompatibility', async () => {
  const calls = [];
  await assert.rejects(
    runPanel({
      model: DEEPSEEK_PRO_MODEL,
      taskText: 'Review.',
      requireVerdict: true,
      provider: 'deepseek',
      absoluteDeadlineMs: Date.now() + 1000,
      run_id: 'panel-no-provider-test',
      invokeWithFallbackFn: async ({ model }) => {
        calls.push(model);
        return { provider: 'deepseek', model_used: model, commandOutput: 'VERDICT: APPROVED\n\nRationale: ok.' };
      },
    }),
    /Panel member qwen3\.7-plus has no available serving transport/,
  );
  assert.deepEqual(calls, []);
});

test('runPanel uses the caller deadline and does not invoke after it expires', async () => {
  let calls = 0;
  const result = await runPanel({
    model: DEEPSEEK_PRO_MODEL,
    taskText: 'Review.',
    requireVerdict: true,
    provider: 'opencode',
    timeoutMs: 1000,
    absoluteDeadlineMs: Date.now() - 1,
    run_id: 'panel-expired-test',
    invokeWithFallbackFn: async () => { calls++; throw new Error('must not run'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.verdict, null);
  assert.equal(result.consensus.judgments_count, 0);
  assert.equal(result.consensus.abstentions_count, 2);
  assert.ok(result.members.every(member => member.classification.mechanism === 'TIMEOUT'));
});

test('runAsk --panel skips the primary/fallback/buddy flow and returns split WARNING consensus', async () => {
  const calls = [];
  const result = await runAsk({
    model: DEEPSEEK_PRO_MODEL,
    taskText: 'Review.',
    requireVerdict: true,
    panel: true,
    provider: 'opencode',
    invokeWithFallbackFn: async ({ model }) => {
      calls.push(model);
      const verdict = model === DEEPSEEK_PRO_MODEL ? 'APPROVED' : 'WARNING';
      return { provider: 'opencode', model_used: model, commandOutput: `VERDICT: ${verdict}\n\nRationale: independent review.` };
    },
  });
  assert.deepEqual(new Set(calls), new Set([DEEPSEEK_PRO_MODEL, QWEN_MODEL]));
  assert.equal(calls.length, 2, 'panel members are the only model invocations');
  assert.equal(result.verdict, 'WARNING');
  assert.equal(result.failed, false);
  assert.equal(result.cross_verify, null);
  assert.equal(result.metadata.panel.k, 2);
});

test('runAsk --panel --risk trivial uses the solo path and emits no panel.result event', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-risk-solo-log-'));
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmp;
  const calls = [];
  try {
    const result = await runAsk({
      model: DEEPSEEK_PRO_MODEL,
      taskText: 'Review.',
      requireVerdict: true,
      panel: true,
      risk: 'trivial',
      lens: 'security',
      provider: 'opencode',
      invokeWithFallbackFn: async options => {
        calls.push(options);
        return { provider: 'opencode', model_used: options.model, commandOutput: 'VERDICT: APPROVED\n\nRationale: tiny change is sound.' };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, DEEPSEEK_PRO_MODEL);
    assert.match(calls[0].prompt, /Injection surfaces/);
    assert.doesNotMatch(calls[0].prompt, /Module boundaries/);
    assert.doesNotMatch(calls[0].prompt, /Code smells/);
    assert.equal(result.verdict, 'APPROVED');
    assert.equal(Object.hasOwn(result, 'consensus'), false);
    assert.equal(Object.hasOwn(result, 'members'), false);
    assert.equal(Object.hasOwn(result.metadata, 'panel'), false);
    const entries = await readLog();
    assert.equal(entries.some(entry => entry.event === 'panel.result' && entry.run_id === result.run_id), false);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runAsk risk default/high and bare --panel use the same cross-family K=2 panel path', async () => {
  for (const risk of [undefined, 'default', 'high']) {
    const calls = [];
    const result = await runAsk({
      model: DEEPSEEK_PRO_MODEL,
      taskText: 'Review.',
      requireVerdict: true,
      panel: true,
      risk,
      lens: 'tdd',
      invokeWithFallbackFn: async options => {
        calls.push(options);
        return { provider: 'opencode', model_used: options.model, commandOutput: 'VERDICT: APPROVED\n\nRationale: independent review.' };
      },
    });
    assert.deepEqual(calls.map(call => call.model).sort(), [DEEPSEEK_PRO_MODEL, QWEN_MODEL].sort());
    assert.ok(calls.every(call => call.noFallback === (risk === 'high')));
    assert.ok(calls.every(call => call.prompt.includes('Test-contract alignment') === (risk !== 'high')),
      `${risk ?? 'bare'} panel must preserve the caller lens unless high risk`);
    assert.ok(calls.every(call => call.prompt.includes('Injection surfaces') === (risk === 'high')));
    assert.ok(calls.every(call => call.prompt.includes('Correctness') === (risk === 'high')));
    assert.ok(calls.every(call => call.prompt.includes('Module boundaries') === (risk === 'high')));
    assert.equal(result.consensus.k, 2);
    assert.equal(result.consensus.n, 2);
    assert.equal(result.members.length, 2);
  }
});

test('runAsk --risk auto selects solo for a tiny diff and panel for high or prose context', async () => {
  const tiny = 'diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-old\n+new';
  const high = `diff --git a/src/module.mjs b/src/module.mjs\n--- a/src/module.mjs\n+++ b/src/module.mjs\n@@ -0,0 +1,401 @@\n${Array.from({ length: 401 }, (_, i) => `+line ${i}`).join('\n')}`;
  for (const [contextText, expectedCalls, expectsPanel] of [
    [tiny, 1, false],
    [high, 2, true],
    ['Review this module carefully.', 2, true],
  ]) {
    const calls = [];
    const result = await runAsk({
      model: DEEPSEEK_PRO_MODEL,
      taskText: 'Review.',
      contextText,
      requireVerdict: true,
      panel: true,
      risk: 'auto',
      invokeWithFallbackFn: async options => {
        calls.push(options);
        return { provider: 'opencode', model_used: options.model, commandOutput: 'VERDICT: APPROVED\n\nRationale: reviewed.' };
      },
    });
    assert.equal(calls.length, expectedCalls);
    assert.equal(Object.hasOwn(result, 'consensus'), expectsPanel);
    assert.equal(Object.hasOwn(result, 'members'), expectsPanel);
  }
});

test('runPanel logs panel.result and keeps scrubbed mechanism messages local-only', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-panel-log-'));
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmp;
  const secret = 'sk-panel-injected-secret-123456789';
  try {
    const result = await runPanel({
      model: DEEPSEEK_PRO_MODEL,
      taskText: 'Review.',
      requireVerdict: true,
      provider: 'opencode',
      absoluteDeadlineMs: Date.now() + 1000,
      run_id: 'panel-log-test',
      env: { ...process.env, DEEPSEEK_API_KEY: secret },
      invokeWithFallbackFn: async () => {
        throw Object.assign(new ProviderError(`provider echoed ${secret}`, 'AUTH_FAILURE'), { code: 'AUTH_FAILURE', provider: 'opencode' });
      },
    });
    assert.equal(JSON.stringify(result).includes(secret), false, 'mechanism text must not enter the panel envelope');
    const entries = await readLog();
    const panelRecord = entries.find(entry => entry.event === 'panel.result' && entry.run_id === 'panel-log-test');
    assert.ok(panelRecord);
    assert.equal(panelRecord.verdict, null);
    assert.equal(panelRecord.judgments_count, 0);
    assert.equal(panelRecord.abstentions_count, 2);
    assert.equal(panelRecord.degraded, true);
    const attempts = entries.filter(entry => entry.event === 'attempt.result' && entry.run_id === 'panel-log-test');
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every(entry => !entry.mechanism_message.includes(secret)));
    assert.ok(attempts.every(entry => /redacted:own-key-/.test(entry.mechanism_message)));
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('same-family fallback rejects', () => {
  assert.throws(() => guardAllowedModels({ model: DEEPSEEK_MODEL, fallbackModel: DEEPSEEK_MODEL }), /differ/);
  assert.throws(() => guardAllowedModels({ model: DEEPSEEK_MODEL, fallbackModel: DEEPSEEK_PRO_MODEL }), /opposite/);
  assert.throws(() => guardAllowedModels({ model: DEEPSEEK_MODEL, fallbackModel: 'qwen3.7-free' }), /not allowed/);
});

// ── Prompt builder ──
test('prompt with system, context, verdict, and maxTokens', () => {
  const prompt = buildPrompt({ taskText: 'Review code', systemText: 'Act as security reviewer',
    contextText: 'Changed auth flow', requireVerdict: true, maxTokens: 800 });
  assert.match(prompt, /^## SYSTEM INSTRUCTIONS/);
  assert.match(prompt, /## TASK/);
  assert.match(prompt, /## CONTEXT/);
  assert.match(prompt, /analytical review/);
  assert.match(prompt, /Think step by step/);
  assert.match(prompt, /Near the top/);
  assert.match(prompt, /review-only task/);
  assert.match(prompt, /approximately 800 tokens/);
});

test('architecture lens injects framework', () => {
  const prompt = buildPrompt({ taskText: 'Review arch', requireVerdict: true, lens: 'architecture' });
  assert.match(prompt, /## AUDIT FRAMEWORK/);
  assert.match(prompt, /Module boundaries/);
  assert.match(prompt, /Deep vs shallow/);
});

test('security lens injects framework', () => {
  const prompt = buildPrompt({ taskText: 'Audit', requireVerdict: true, lens: 'security' });
  assert.match(prompt, /## AUDIT FRAMEWORK/);
  assert.match(prompt, /Injection surfaces/);
  assert.match(prompt, /Auth and access/);
});

test('high-risk-full lens combines security, code-review, and architecture in one audit framework', () => {
  const prompt = buildPrompt({ taskText: 'Audit', requireVerdict: true, lens: 'high-risk-full' });
  assert.equal(prompt.match(/## AUDIT FRAMEWORK/g)?.length, 1);
  assert.match(prompt, /## AUDIT FRAMEWORK — HIGH-RISK-FULL/);
  assert.match(prompt, /Injection surfaces/);
  assert.match(prompt, /Correctness/);
  assert.match(prompt, /Module boundaries/);
});

test('general lens omits framework', () => {
  const prompt = buildPrompt({ taskText: 'Check', requireVerdict: true, lens: 'general' });
  assert.doesNotMatch(prompt, /## AUDIT FRAMEWORK/);
});

test('non-review mode uses default guidance', () => {
  const prompt = buildPrompt({ taskText: 'Answer', requireVerdict: false });
  assert.match(prompt, /Answer directly/);
  assert.doesNotMatch(prompt, /analytical review/);
});

test('all lenses produce valid prompts', () => {
  for (const lens of ['code-review', 'architecture', 'security', 'tdd', 'maintainability', 'deep-modules']) {
    const prompt = buildPrompt({ taskText: 'Review', requireVerdict: true, lens });
    assert.match(prompt, /## AUDIT FRAMEWORK/, `${lens} lens`);
    assert.ok(prompt.length > 200, `${lens} prompt too short`);
  }
});

// ── prompt_hash (#9): deterministic one-way digest of the prompt ──
// The prompt hash lets failures be correlated by task. These properties MUST hold.
// (They FAIL against the old randomBytes-based promptHash: two identical prompts
// previously hashed differently, so correlation was impossible.)
test('promptHash is stable: identical prompt text → identical hash (correlation)', () => {
  const text = 'Review the auth module for injection surfaces.';
  const a = promptHash(text);
  const b = promptHash(text);
  assert.equal(a, b, 'identical prompt text must produce an identical hash');
  assert.match(a, /^[0-9a-f]{16}$/, 'digest is a 16-char lowercase-hex prefix');
});

test('promptHash discriminates: different prompt text → different hash', () => {
  const h1 = promptHash('Review the auth module for injection surfaces.');
  const h2 = promptHash('Review the auth module for privilege escalation.');
  assert.notEqual(h1, h2, 'different prompt text must produce a different hash');
});

test('promptHash never contains prompt text — it is a pure hex digest', () => {
  const distinctive = 'SUPERCALIFRAGILISTIC-secret-token-9876543210';
  const text = `Please audit ${distinctive} carefully.`;
  const h = promptHash(text);
  assert.match(h, /^[0-9a-f]+$/, 'a digest contains only hex characters');
  assert.ok(!h.includes(distinctive), 'distinctive input substring must not appear in the digest');
  // Cross-check against an independently computed SHA-256 prefix: pins both the
  // algorithm and the 16-char truncation.
  assert.equal(h, createHash('sha256').update(text).digest('hex').slice(0, 16));
});

// ── Output validation ──
test('verdict accepts APPROVED, WARNING, BLOCKED', () => {
  validateAssistantOutput('VERDICT: APPROVED\n\nRationale: correct.', { requireVerdict: true });
  validateAssistantOutput('VERDICT: WARNING\n\nRationale: issue found.', { requireVerdict: true });
  validateAssistantOutput('VERDICT: BLOCKED\n\nRationale: must fix.', { requireVerdict: true });
});

test('missing verdict or rationale errors', () => {
  assert.throws(() => validateAssistantOutput('Just text', { requireVerdict: true }), /explicit/);
  assert.throws(() => validateAssistantOutput('VERDICT: APPROVED', { requireVerdict: true }), /rationale/);
});

test('JSON verdict contract', () => {
  const result = validateAssistantOutput('{"verdict":"APPROVED","reason":"good"}', { jsonMode: true, requireVerdict: true });
  assert.deepEqual(result, { verdict: 'APPROVED', reason: 'good' });
});

test('numeric output rejected', () => {
  assert.throws(() => validateAssistantOutput('12345'), /alphabetic/);
  assert.throws(() => validateAssistantOutput('{"verdict":"APPROVED","reason":"12345"}', { jsonMode: true, requireVerdict: true }), /alphabetic/);
});

// ── JSONL Parser ──
test('JSONL parser handles duplicates and non-text events', () => {
  const result = parseOpenCodeJsonl(
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'Hello' } }) + '\n' +
    JSON.stringify({ type: 'error', part: { type: 'error', message: 'oops' } }) + '\n' +
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'World' } })
  );
  assert.equal(result, 'Hello\nWorld');
});

// ── extractJsonObject ──
test('extractJsonObject validates structure', () => {
  assert.throws(() => extractJsonObject('bad'), /parse/);
  assert.throws(() => extractJsonObject('[1,2,3]'), /not an object/);
  assert.throws(() => extractJsonObject('123'), /not an object/);
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

// ── File input ──
test('inline literals bypass stat, paths resolved', async () => {
  assert.equal(await readExistingPathOrLiteral('inline'), 'inline');
  const multiline = 'line1\nline2';
  assert.equal(await readExistingPathOrLiteral(multiline), multiline);
});

// ── runMain validation gates (tested before provider invocation) ──
// #11 contract: a usage/arg throw is a no-judgment -> exit band 30 (was exit 1).
// The human stderr line is still emitted; the band simply moved from 1 to 30.
test('runMain rejects unknown flag', async () => {
  const stderr = []; const prev = process.exitCode;
  await runMain(['--model', QWEN_MODEL, '--task', 'test', '--bogus'], () => {}, (l) => stderr.push(l));
  assert.match(stderr.join(''), /Unknown option/);
  assert.equal(process.exitCode, 30, 'usage throw is no-judgment band 30, not 1');
  process.exitCode = prev;
});

test('runMain accepts every supported --risk value only with --panel', async () => {
  for (const risk of ['auto', 'trivial', 'default', 'high']) {
    let receivedRisk = null;
    const run = await runFakeMain(
      ['--model', DEEPSEEK_PRO_MODEL, '--task', 't', '--panel', '--risk', risk, '--json'],
      async options => {
        receivedRisk = options.risk;
        return fakePanelEnvelope({ verdict: 'APPROVED', judgments: 2, abstentions: 0 });
      },
    );
    assert.equal(run.exitCode, 0, `${risk}: ${run.stderr}`);
    assert.equal(receivedRisk, risk);
    assert.ok(run.stdout.length > 0);
  }
});

test('runMain rejects invalid --risk values and --risk without --panel', async () => {
  let invoked = false;
  const invalid = await runFakeMain(
    ['--model', DEEPSEEK_PRO_MODEL, '--task', 't', '--panel', '--risk', 'extreme', '--json'],
    async () => { invoked = true; },
  );
  assert.equal(invalid.exitCode, 30);
  assert.match(invalid.stderr, /--risk must be one of: auto, trivial, default, high/);
  assert.ok(invalid.stdout.length > 0);

  const withoutPanel = await runFakeMain(
    ['--model', DEEPSEEK_PRO_MODEL, '--task', 't', '--risk', 'trivial', '--json'],
    async () => { invoked = true; },
  );
  assert.equal(withoutPanel.exitCode, 30);
  assert.match(withoutPanel.stderr, /--risk requires --panel/);
  assert.ok(withoutPanel.stdout.length > 0);
  assert.equal(invoked, false);
});

test('runMain rejects missing model or task', async () => {
  const stderr = []; const prev = process.exitCode;
  await runMain(['--model', QWEN_MODEL], () => {}, (l) => stderr.push(l));
  assert.ok(stderr.join('').includes('Usage'));
  assert.equal(process.exitCode, 30, 'usage throw is no-judgment band 30, not 1');
  process.exitCode = prev;
});

test('resolveTimeout defaults to measured timeout when caller omits value', () => {
  assert.equal(resolveTimeout(), 170000);
});

test('resolveTimeout maps 0 to default timeout and never interprets it as unbounded', () => {
  assert.equal(resolveTimeout(0), 170000);
});

test('resolveTimeout caps caller timeout at the delegation hard ceiling', () => {
  assert.equal(resolveTimeout(500000), 300000);
});

test('resolveTimeout keeps the review ceiling when explicitly requested', () => {
  assert.equal(resolveTimeout(600000, { hardCeilMs: 900000 }), 600000);
  assert.equal(resolveTimeout(1_000_000, { hardCeilMs: 900000 }), 900000);
});

test('resolveTimeout keeps the default timeout when request is omitted even with raised review ceiling', () => {
  assert.equal(resolveTimeout(0, { hardCeilMs: 900000 }), 170000);
  assert.equal(resolveTimeout(undefined, { hardCeilMs: 900000 }), 170000);
});

test('runMain maps absent --timeout-ms to default', async () => {
  let askedTimeoutMs;
  const { exitCode } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--json'],
    async ({ timeoutMs }) => {
      askedTimeoutMs = timeoutMs;
      return { output: 'ok', model: QWEN_MODEL, verdict: null, classification: null, metadata: {}, run_id: 'fake' };
    },
  );
  assert.equal(askedTimeoutMs, 170000);
  assert.equal(exitCode, 0);
});

test('runMain maps absent --timeout-ms to default for review operations', async () => {
  let askedTimeoutMs;
  const { exitCode } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--require-verdict', '--json'],
    async ({ timeoutMs }) => {
      askedTimeoutMs = timeoutMs;
      return { output: 'ok', model: QWEN_MODEL, verdict: null, classification: null, metadata: {}, run_id: 'fake' };
    },
  );
  assert.equal(askedTimeoutMs, 170000);
  assert.equal(exitCode, 0);
});

test('runMain caps explicit --timeout-ms above the hard ceiling', async () => {
  let askedTimeoutMs;
  const { exitCode } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--timeout-ms', '500000', '--json'],
    async ({ timeoutMs }) => {
      askedTimeoutMs = timeoutMs;
      return { output: 'ok', model: QWEN_MODEL, verdict: null, classification: null, metadata: {}, run_id: 'fake' };
    },
  );
  assert.equal(askedTimeoutMs, 300000);
  assert.equal(exitCode, 0);
});

test('runMain uses review ceiling for --require-verdict workloads', async () => {
  let askedTimeoutMs;
  const { exitCode } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--require-verdict', '--timeout-ms', '600000', '--json'],
    async ({ timeoutMs }) => {
      askedTimeoutMs = timeoutMs;
      return { output: 'ok', model: QWEN_MODEL, verdict: 'APPROVED', classification: null, metadata: {}, run_id: 'fake' };
    },
  );
  assert.equal(askedTimeoutMs, 600000);
  assert.equal(exitCode, 0);
});

test('runMain caps explicit --timeout-ms above the review ceiling', async () => {
  let askedTimeoutMs;
  const { exitCode } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--require-verdict', '--timeout-ms', '1000000', '--json'],
    async ({ timeoutMs }) => {
      askedTimeoutMs = timeoutMs;
      return { output: 'ok', model: QWEN_MODEL, verdict: 'APPROVED', classification: null, metadata: {}, run_id: 'fake' };
    },
  );
  assert.equal(askedTimeoutMs, 900000);
  assert.equal(exitCode, 0);
});

test('runMain treats explicit --timeout-ms 0 as default, not unbounded', async () => {
  let askedTimeoutMs;
  const { exitCode } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--timeout-ms', '0', '--json'],
    async ({ timeoutMs }) => {
      askedTimeoutMs = timeoutMs;
      return { output: 'ok', model: QWEN_MODEL, verdict: null, classification: null, metadata: {}, run_id: 'fake' };
    },
  );
  assert.equal(askedTimeoutMs, 170000);
  assert.equal(exitCode, 0);
});

test('shared deadline math: fallback receives only remaining wall-clock', () => {
  const start = 1000;
  const effectiveTimeoutMs = resolveTimeout();
  const absoluteDeadlineMs = start + effectiveTimeoutMs;
  const primaryConsumedMs = 50000;
  const primaryRemainingMs = remainingBudget(absoluteDeadlineMs, start + primaryConsumedMs);
  const fallbackRemainingMs = remainingBudget(absoluteDeadlineMs, start + primaryConsumedMs + 1000);
  assert.equal(primaryRemainingMs, 120000);
  assert.equal(fallbackRemainingMs, 119000);
  assert.ok(fallbackRemainingMs <= effectiveTimeoutMs - primaryConsumedMs);
});

// ── Provider factory (unit) ──
test('modelFamily classification', async () => {
  const { modelFamily } = await import('./providers/factory.mjs');
  assert.equal(modelFamily('deepseek-v4-pro'), 'deepseek');
  assert.equal(modelFamily('qwen3.7-plus'), 'qwen');
  assert.equal(modelFamily('unknown'), null);
});

test('defaultProvider maps models', async () => {
  const { defaultProvider } = await import('./providers/factory.mjs');
  assert.equal(defaultProvider('deepseek-v4-pro'), 'deepseek');
  assert.equal(defaultProvider('qwen3.7-plus'), 'qwen');
  assert.throws(() => defaultProvider('bogus'));
});

test('ProviderError is classified', async () => {
  const { ProviderError } = await import('./providers/factory.mjs');
  const e = new ProviderError('msg', 'RATE_LIMITED');
  assert.equal(e.code, 'RATE_LIMITED');
  assert.ok(e instanceof Error);
});

test('availableProviders lists all', async () => {
  const { availableProviders } = await import('./providers/factory.mjs');
  const providers = availableProviders();
  assert.ok(providers.includes('opencode'));
  assert.ok(providers.includes('deepseek'));
  assert.ok(providers.includes('qwen'));
});

test('resolveProviderChain enforces the identity-trust transport set', async () => {
  assert.deepEqual(resolveProviderChain({ model: DEEPSEEK_PRO_MODEL, noFallback: true }), ['deepseek', 'opencode']);
  assert.deepEqual(resolveProviderChain({ model: QWEN_MODEL, noFallback: true }), ['qwen', 'opencode']);
  assert.deepEqual(resolveProviderChain({ model: DEEPSEEK_PRO_MODEL, noFallback: true, preferredProvider: 'deepseek' }), ['deepseek']);
  assert.deepEqual(resolveProviderChain({ model: DEEPSEEK_PRO_MODEL, noFallback: true, preferredProvider: 'opencode' }), ['opencode']);
  assert.ok(!resolveProviderChain({ model: DEEPSEEK_PRO_MODEL, noFallback: false }).includes('qwen'));
  assert.ok(!resolveProviderChain({ model: QWEN_MODEL, noFallback: false }).includes('deepseek'));
  assert.deepEqual(
    resolveProviderChain({ model: DEEPSEEK_PRO_MODEL, chain: { deepseek: ['qwen', 'opencode', 'deepseek'] } }),
    ['opencode', 'deepseek'],
    'configured chains receive the same final serving filter',
  );
  assert.deepEqual(
    resolveProviderChain({ model: QWEN_MODEL, chain: { qwen: ['deepseek', 'opencode', 'qwen'] } }),
    ['opencode', 'qwen'],
    'the final serving filter is symmetric for qwen-family models',
  );
  assert.throws(
    () => resolveProviderChain({ model: DEEPSEEK_PRO_MODEL, preferredProvider: 'qwen' }),
    error => error.code === 'MODEL_NOT_FOUND',
  );
  assert.throws(
    () => resolveProviderChain({ model: QWEN_MODEL, preferredProvider: 'deepseek' }),
    error => error.code === 'MODEL_NOT_FOUND',
  );
  assert.deepEqual(
    resolveProviderChain({ model: DEEPSEEK_MODEL, noFallback: true, chain: { deepseek: ['opencode'] } }),
    [],
    'an unlisted transport is not implicitly trusted under the identity pin',
  );
});

test('identity pin always admits a model native provider without weakening family isolation', async () => {
  const unlistedQwenModel = 'qwen3.7-max';
  assert.deepEqual(
    resolveProviderChain({ model: DEEPSEEK_MODEL, noFallback: true }),
    ['deepseek'],
    'an unlisted DeepSeek model retains its native transport',
  );
  assert.deepEqual(
    resolveProviderChain({ model: DEEPSEEK_MODEL, preferredProvider: 'deepseek', noFallback: true }),
    ['deepseek'],
    'an explicitly pinned native transport is accepted',
  );
  assert.equal(isIdentityPreservingTransport(DEEPSEEK_MODEL, 'deepseek'), true);
  assert.deepEqual(
    resolveProviderChain({ model: unlistedQwenModel, noFallback: true }),
    ['qwen'],
    'an unlisted Qwen model retains its native transport',
  );
  assert.equal(isIdentityPreservingTransport(unlistedQwenModel, 'qwen'), true);
  assert.ok(
    !resolveProviderChain({
      model: DEEPSEEK_MODEL,
      noFallback: true,
      chain: { deepseek: ['qwen', 'deepseek'] },
    }).includes('qwen'),
    'a DeepSeek model never crosses into the Qwen provider',
  );
  assert.throws(
    () => resolveProviderChain({ model: DEEPSEEK_MODEL, preferredProvider: 'qwen', noFallback: true }),
    error => error.code === 'MODEL_NOT_FOUND',
  );
  assert.throws(
    () => resolveProviderChain({ model: unlistedQwenModel, preferredProvider: 'deepseek', noFallback: true }),
    error => error.code === 'MODEL_NOT_FOUND',
  );
});

test('identity trust declarations are explicit, auditable, and provide executable routes', () => {
  const table = identityTransportTrustTable();
  for (const [model, entries] of Object.entries(table)) {
    for (const entry of entries) {
      assert.equal(entry.equivalence, 'declared', `${model}/${entry.provider}`);
      assert.match(entry.declaration, /Human-curated declaration/);
      assert.equal(entry.provenance, '.evidence/issue5-nofallback-decision.md');
      assert.ok(Object.hasOwn(entry, 'snapshotId'));
      assert.equal(entry.snapshotId, null);
      assert.equal(entry.snapshotStatus, 'vendor-exposes-no-snapshot');
      assert.equal(identityTransportRoute(model, entry.provider), entry.modelRoute);
    }
  }
});

test('explicit qwen provider for a deepseek model hard-rejects before invocation', async () => {
  let fetchCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('must not be called'); };
  try {
    await assert.rejects(
      invokeWithFallback({
        model: DEEPSEEK_PRO_MODEL,
        prompt: 'never sent',
        preferredProvider: 'qwen',
        env: { ...process.env, QWEN_API_KEY: 'would-attempt-if-routing-were-wrong' },
      }),
      error => error.code === 'MODEL_NOT_FOUND' && error.provider === 'qwen',
    );
    assert.equal(fetchCalls, 0, 'the incompatible provider was never attempted');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('unlisted transport under the identity pin fails our-side without invocation', async () => {
  await assert.rejects(
    invokeWithFallback({
      model: DEEPSEEK_MODEL,
      prompt: 'never sent',
      noFallback: true,
      chain: { deepseek: ['opencode'] },
      env: { ...process.env, PATH: '' },
    }),
    error => error.code === 'NO_PROVIDER',
  );
});

test('default fallback skips an unconfigured native transport without invoking it', async () => {
  const fixture = await makeFakeOpenCodeCli();
  let fetchCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('DeepSeek invoke must not reach fetch'); };
  try {
    const result = await invokeWithFallback({
      model: DEEPSEEK_PRO_MODEL,
      prompt: 'use the configured fallback',
      env: fixture.env,
    });
    assert.equal(result.provider, 'opencode');
    assert.deepEqual(result.attempts, [{
      provider: 'deepseek',
      duration_ms: 0,
      outcome: 'skipped',
      reason_code: 'NOT_CONFIGURED',
    }]);
    assert.equal(fetchCalls, 0, 'the unconfigured DeepSeek transport was never invoked');
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('an unconfigured transport is still attempted when skipping would empty the chain', async () => {
  const fixture = await makeFakeOpenCodeCli();
  try {
    await assert.rejects(
      invokeWithFallback({
        model: DEEPSEEK_PRO_MODEL,
        prompt: 'retain one transport',
        chain: { deepseek: ['deepseek'] },
        env: fixture.env,
      }),
      error => error.code === 'ALL_PROVIDERS_EXHAUSTED'
        && error.cause?.code === 'AUTH_FAILURE'
        && error.attempts?.[0]?.outcome === 'failed',
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('provider exhaustion names only transports that genuinely attempted invocation', async () => {
  const fixture = await makeFakeOpenCodeCli('failure');
  try {
    await assert.rejects(
      invokeWithFallback({
        model: DEEPSEEK_PRO_MODEL,
        prompt: 'force exhaustion',
        env: fixture.env,
      }),
      error => {
        assert.equal(error.code, 'ALL_PROVIDERS_EXHAUSTED');
        assert.match(error.message, /opencode/);
        assert.doesNotMatch(error.message, /deepseek/);
        assert.deepEqual(error.attempts.map(({ provider, outcome, reason_code }) => ({ provider, outcome, reason_code })), [
          { provider: 'deepseek', outcome: 'skipped', reason_code: 'NOT_CONFIGURED' },
          { provider: 'opencode', outcome: 'failed', reason_code: 'PROVIDER_ERROR' },
        ]);
        return true;
      },
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

// install.sh installs the CLI as a symlink, so argv[1] is the link path while
// import.meta.url is the resolved target. `pricing` is local-only: no network,
// no spend. A silent exit 0 here is the exact shape of the outage this guards.
test('entrypoint: main() runs when the CLI is invoked through a symlink', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-entrypoint-'));
  try {
    const link = path.join(tmp, 'ocask');
    await fs.symlink(fileURLToPath(new URL('ocask.mjs', import.meta.url)), link);
    const run = spawnSync(process.execPath, [link, 'pricing'], { encoding: 'utf8' });
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
    assert.match(run.stdout, /Pricing/, 'symlink invocation must produce real output, not a silent exit 0');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('entrypoint: main() does not run when the module is merely imported', async () => {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-import-'));
  try {
    const file = path.join(probe, 'probe.mjs');
    const target = fileURLToPath(new URL('ocask.mjs', import.meta.url));
    await fs.writeFile(file, `import ${JSON.stringify(target)}; console.log('imported-clean');\n`);
    const run = spawnSync(process.execPath, [file], { encoding: 'utf8' });
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
    assert.match(run.stdout, /imported-clean/);
    assert.doesNotMatch(run.stdout, /Usage:/, 'importing must not trigger the CLI');
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
});

// ── Failure-record taxonomy (#2) + contract (#3) ──
// These FAIL against the pre-fix code (everything collapsed to all_exhausted) and
// PASS once classifyFailure unwraps the factory wrapper to the true mechanism.

// Build an error wrapped exactly as providers/factory.mjs wraps a terminal failure:
// ALL_PROVIDERS_EXHAUSTED with `.cause` = the originating ProviderError.
function wrapAsExhausted(origin) {
  return Object.assign(
    new ProviderError(`All providers exhausted (${origin.provider || 'unknown'}); last: ${origin.message}`, 'ALL_PROVIDERS_EXHAUSTED'),
    { attempts: [{ provider: origin.provider || 'unknown', outcome: 'failed', reason_code: origin.code }], cause: origin },
  );
}

test('a factory-wrapped TIMEOUT classifies to the true mechanism (never all_exhausted)', () => {
  const origin = Object.assign(
    new ProviderError('DeepSeek API timed out after 5000ms', 'TIMEOUT'),
    { code: 'TIMEOUT', provider: 'deepseek' },
  );
  const cls = classifyFailure(wrapAsExhausted(origin));
  assert.equal(cls.class, 'no-judgment');
  assert.equal(cls.subclass, 'reply-absent');
  assert.equal(cls.locus, 'their-side');
  assert.equal(cls.mechanism, 'TIMEOUT');
  assert.equal(cls.censored, true);
  assert.notEqual(cls.mechanism, 'all_exhausted');
  assert.notEqual(cls.mechanism, 'ALL_PROVIDERS_EXHAUSTED');
});

test('unwrapOrigin reaches the originating cause and preserves the real provider', () => {
  const origin = Object.assign(
    new ProviderError('DEEPSEEK_API_KEY not set', 'AUTH_FAILURE'),
    { code: 'AUTH_FAILURE', provider: 'deepseek' },
  );
  const wrapped = wrapAsExhausted(origin);
  assert.equal(unwrapOrigin(wrapped), origin);
  assert.equal(unwrapOrigin(wrapped).provider, 'deepseek');
  // An already-originating error (no wrapper) is returned unchanged.
  assert.equal(unwrapOrigin(origin), origin);
});

test('AUTH_FAILURE classifies as our-side with mechanism AUTH_FAILURE', () => {
  const origin = Object.assign(
    new ProviderError('DEEPSEEK_API_KEY not set', 'AUTH_FAILURE'),
    { code: 'AUTH_FAILURE', provider: 'deepseek' },
  );
  const cls = classifyFailure(wrapAsExhausted(origin));
  assert.equal(cls.class, 'no-judgment');
  assert.equal(cls.subclass, 'reply-absent');
  assert.equal(cls.locus, 'our-side');
  assert.equal(cls.mechanism, 'AUTH_FAILURE');
  assert.equal(cls.censored, false);
  // Provider attribution comes from the unwrapped cause — never 'unknown'.
  assert.equal(unwrapOrigin(wrapAsExhausted(origin)).provider, 'deepseek');
});

test('unknown / undefined code classifies as indeterminate, never a verdict', () => {
  const weird = Object.assign(
    new ProviderError('something broke', 'SOMETHING_WEIRD'),
    { code: 'SOMETHING_WEIRD', provider: 'qwen' },
  );
  const clsUnknown = classifyFailure(wrapAsExhausted(weird));
  assert.equal(clsUnknown.class, 'no-judgment');
  assert.equal(clsUnknown.subclass, 'indeterminate');
  assert.equal(clsUnknown.locus, null);

  const clsNone = classifyFailure(undefined);
  assert.equal(clsNone.class, 'no-judgment');
  assert.equal(clsNone.subclass, 'indeterminate');
  assert.equal(clsNone.mechanism, null);
});

test('a validated verdict classifies as judgment; a non-verdict never does', () => {
  for (const v of ['APPROVED', 'WARNING', 'BLOCKED']) {
    const cls = classifyFailure(null, { verdict: v });
    assert.equal(cls.class, 'judgment', v);
    assert.equal(cls.subclass, null, v);
    assert.equal(cls.mechanism, null, v);
  }
  assert.equal(classifyFailure(null, { verdict: null }).class, 'no-judgment');
  assert.equal(classifyFailure(null, { verdict: 'MAYBE' }).class, 'no-judgment');
});

test('the ALL_PROVIDERS_EXHAUSTED wrapper never appears as a reported mechanism', () => {
  for (const code of ['TIMEOUT', 'AUTH_FAILURE', 'RATE_LIMITED', 'CONNECTION_ERROR',
    'ENTITLEMENT_UNAVAILABLE', 'PROVIDER_ERROR', 'MALFORMED_RESPONSE', 'MODEL_OUTPUT',
    'INSUFFICIENT_BALANCE', 'MODEL_NOT_ALLOWED']) {
    const origin = Object.assign(new ProviderError(code, code), { code, provider: 'deepseek' });
    const cls = classifyFailure(wrapAsExhausted(origin));
    assert.notEqual(cls.mechanism, 'ALL_PROVIDERS_EXHAUSTED', code);
    assert.notEqual(cls.mechanism, 'all_exhausted', code);
    assert.equal(cls.mechanism, code, `${code} should be the reported mechanism`);
  }
});

test('non-empty malformed model output classifies as reply-unusable', () => {
  // MODEL_OUTPUT surfaces UNwrapped (validateAssistantOutput throws it after the
  // provider already returned successfully), so classify it directly.
  const origin = Object.assign(new ProviderError('missing verdict line', 'MODEL_OUTPUT'), { code: 'MODEL_OUTPUT' });
  const cls = classifyFailure(origin);
  assert.equal(cls.class, 'no-judgment');
  assert.equal(cls.subclass, 'reply-unusable');
  assert.equal(cls.locus, null);
  assert.equal(cls.censored, false);
});

test('HTTP status and retry-after propagate from the originating cause', () => {
  const origin = Object.assign(
    new ProviderError('rate limited', 'RATE_LIMITED'),
    { code: 'RATE_LIMITED', provider: 'qwen', status: 429, retryAfter: '42' },
  );
  const cls = classifyFailure(wrapAsExhausted(origin));
  assert.equal(cls.mechanism, 'RATE_LIMITED');
  assert.equal(cls.locus, 'our-side');
  assert.equal(cls.http_status, 429);
  assert.equal(cls.retry_after, '42');
});

test('logAttemptResult writes the full failure-record taxonomy to the log', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-tax-'));
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevDeepseek = process.env.DEEPSEEK_API_KEY;
  const mechanismValue = 'sk-live-fake-key-1234567890';
  process.env.DEEPSEEK_API_KEY = mechanismValue;
  process.env.XDG_DATA_HOME = tmp;
  startRun('tax-test-run');
  try {
    const origin = Object.assign(
      new ProviderError('timed out', 'TIMEOUT'),
      { code: 'TIMEOUT', provider: 'deepseek' },
    );
    const wrapped = wrapAsExhausted(origin);
    const classification = classifyFailure(wrapped);
    await logAttemptResult({
      provider: unwrapOrigin(wrapped).provider, model: 'deepseek-v4-flash',
      attemptIndex: 0, outcome: 'failed', durationMs: 5000, timeoutMs: 5000,
      reasonCode: classification.mechanism, outputBytes: 0, tokensUsed: null,
      errorClass: 'ProviderError', classification, mechanismMessage: `timed out with ${mechanismValue}`,
    });
    const entries = await readLog();
    const rec = entries.find(e => e.event === 'attempt.result');
    assert.ok(rec, 'attempt.result record was written');
    assert.equal(rec.provider, 'deepseek', 'real provider, not unknown');
    assert.equal(rec.mechanism_message.includes('sk-live-fake-key-1234567890'), false);
    assert.equal(rec.class, 'no-judgment');
    assert.equal(rec.subclass, 'reply-absent');
    assert.equal(rec.locus, 'their-side');
    assert.equal(rec.mechanism, 'TIMEOUT', 'true mechanism, not all_exhausted');
    assert.equal(rec.duration_censored, true);
    assert.equal(rec.timeout_ms, 5000);
    assert.equal(rec.reason_code, 'TIMEOUT');
  } finally {
    if (prevDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevDeepseek;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('main(): failure metadata never includes mechanism_message (local-only mechanism text)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-meta-'));
  const metadataPath = path.join(tmp, 'metadata.json');
  const home = path.join(tmp, 'home');
  await fs.mkdir(home, { recursive: true });

  const prevHome = process.env.HOME;
  const prevDataHome = process.env.XDG_DATA_HOME;
  const prevRuntime = process.env.XDG_RUNTIME_DIR;

  process.env.HOME = home;
  process.env.XDG_DATA_HOME = tmp;
  process.env.XDG_RUNTIME_DIR = path.join(tmp, 'runtime');
  try {
    const { exitCode } = await runFakeMain(
      ['--model', DEEPSEEK_MODEL, '--task', 'metadata confinement', '--require-verdict', '--json', '--metadata', metadataPath],
      null,
      { stdout: [], stderr: [] },
      {
        ...process.env,
        HOME: home,
        DEEPSEEK_API_KEY: '',
        QWEN_API_KEY: '',
        OPENCODE_SERVER_PASSWORD: '',
      },
    );
    assert.equal(exitCode, 30);

    const text = await fs.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(text || '{}');
    assert.equal('mechanism_message' in parsed, false, 'mechanism_message must never be in --metadata object');
    assert.equal(Array.isArray(parsed.attempts), true);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevDataHome;
    if (prevRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevRuntime;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ── Four-way caller contract (#11) ──
// ocask signals FOUR outcomes redundantly via exit code AND a self-describing
// --json object. The pure helpers are unit-tested directly; the end-to-end main()
// mapping is exercised through an injected runAsk (7th param) so no provider is
// hit. exit 0 requires a real verdict; BLOCKED is 20; no-judgment is 30.

test('extractVerdict reads prose VERDICT lines and JSON object .verdict', () => {
  assert.equal(extractVerdict('VERDICT: APPROVED\n\nok'), 'APPROVED');
  assert.equal(extractVerdict('VERDICT: WARNING'), 'WARNING');
  assert.equal(extractVerdict('VERDICT: BLOCKED.'), 'BLOCKED');
  assert.equal(extractVerdict('no verdict here'), null);
  assert.equal(extractVerdict(''), null);
  // jsonMode object form
  assert.equal(extractVerdict({ verdict: 'BLOCKED', reason: 'x' }), 'BLOCKED');
  assert.equal(extractVerdict({ verdict: 'approved' }), 'APPROVED'); // case-insensitive
  assert.equal(extractVerdict({ verdict: 'MAYBE' }), null);
  assert.equal(extractVerdict({}), null);
});

test('exitCodeForOutcome: APPROVED/WARNING -> 0, BLOCKED -> 20, failure -> 30, freeform -> 0', () => {
  assert.equal(exitCodeForOutcome({ verdict: 'APPROVED' }), 0);
  assert.equal(exitCodeForOutcome({ verdict: 'WARNING' }), 0);
  assert.equal(exitCodeForOutcome({ verdict: 'BLOCKED' }), 20);
  assert.equal(exitCodeForOutcome({ verdict: null, failed: true }), 30);
  // Freeform success (no verdict requested, but the run succeeded) stays exit 0.
  assert.equal(exitCodeForOutcome({ verdict: null, failed: false }), 0);
  // Reserved shell codes are never produced.
  for (const v of ['APPROVED', 'WARNING', 'BLOCKED']) {
    const code = exitCodeForOutcome({ verdict: v });
    assert.ok(![2, 126, 127, 128, 130].includes(code));
  }
});

test('describeOutcome: judgment vs freeform vs failure', () => {
  // Judgment: verdict set, no failure reason.
  const j = describeOutcome({ verdict: 'APPROVED', output: 'VERDICT: APPROVED', failed: false });
  assert.equal(j.outcome, 'judgment');
  assert.equal(j.verdict, 'APPROVED');
  assert.equal(j.reason, null);
  assert.equal(j.locus, null);
  assert.equal(j.mechanism, null);
  assert.equal(j.exit_code, 0);

  // BLOCKED judgment: its own band.
  const b = describeOutcome({ verdict: 'BLOCKED', output: 'x', failed: false });
  assert.equal(b.outcome, 'judgment');
  assert.equal(b.verdict, 'BLOCKED');
  assert.equal(b.exit_code, 20);

  // Freeform success (no verdict, did NOT fail) -> "analysis" outcome, exit 0.
  const f = describeOutcome({ verdict: null, output: 'analysis text', failed: false });
  assert.equal(f.outcome, 'analysis', 'freeform success is analysis, never no-judgment');
  assert.equal(f.verdict, null);
  assert.equal(f.reason, null, 'freeform has no failure reason');
  assert.equal(f.exit_code, 0);

  // Failure -> no-judgment, exit 30, reason/locus/mechanism from classifyFailure.
  const fail = describeOutcome({
    verdict: null, output: null, failed: true,
    classification: { subclass: 'reply-absent', locus: 'our-side', mechanism: 'AUTH_FAILURE' },
  });
  assert.equal(fail.outcome, 'no-judgment');
  assert.equal(fail.verdict, null);
  assert.equal(fail.reason, 'reply-absent');
  assert.equal(fail.locus, 'our-side');
  assert.equal(fail.mechanism, 'AUTH_FAILURE');
  assert.equal(fail.exit_code, 30);
});

test('buildJsonResponse: first-class machine fields + output, exit_code agrees with band', () => {
  const d = describeOutcome({ verdict: 'BLOCKED', output: 'VERDICT: BLOCKED\nfix me', failed: false });
  const json = buildJsonResponse(d);
  // Machine fields are first-class, in the contract's documented order.
  assert.deepEqual(Object.keys(json),
    ['outcome', 'verdict', 'reason', 'locus', 'mechanism', 'exit_code', 'output']);
  assert.equal(json.outcome, 'judgment');
  assert.equal(json.verdict, 'BLOCKED');
  assert.equal(json.reason, null);
  assert.equal(json.exit_code, 20);
  assert.equal(json.output, 'VERDICT: BLOCKED\nfix me');
  // Redundant agreeing signal: JSON exit_code == process exit band.
  assert.equal(json.exit_code, d.exit_code);
});

test('runMain rejects conflicting panel modes before any invocation', async () => {
  let invoked = false;
  const both = await runFakeMain(
    ['--model', DEEPSEEK_PRO_MODEL, '--task', 't', '--require-verdict', '--panel', '--cross-verify'],
    async () => { invoked = true; },
  );
  assert.equal(both.exitCode, 30);
  assert.match(both.stderr, /mutually exclusive/);

  const fallback = await runFakeMain(
    ['--model', DEEPSEEK_PRO_MODEL, '--task', 't', '--require-verdict', '--panel', '--fallback-model', QWEN_MAX_MODEL],
    async () => { invoked = true; },
  );
  assert.equal(fallback.exitCode, 30);
  assert.match(fallback.stderr, /cannot be combined/);
  assert.equal(invoked, false);
});

test('runMain panel consensus composes with WARNING and BLOCKED exit bands', async () => {
  const warningResult = fakePanelEnvelope({ verdict: 'WARNING', judgments: 2, abstentions: 0 });
  const warning = await runFakeMain(
    ['--model', DEEPSEEK_PRO_MODEL, '--task', 't', '--require-verdict', '--panel', '--json'],
    async () => warningResult,
  );
  const warningJson = JSON.parse(warning.stdout);
  assert.equal(warning.exitCode, 0);
  assert.equal(warningJson.outcome, 'judgment');
  assert.equal(warningJson.verdict, 'WARNING');
  assert.equal(warningJson.consensus.judgments_count, 2);

  const blockedResult = fakePanelEnvelope({ verdict: 'BLOCKED', judgments: 2, abstentions: 0 });
  const blocked = await runFakeMain(
    ['--model', DEEPSEEK_PRO_MODEL, '--task', 't', '--require-verdict', '--panel', '--json'],
    async () => blockedResult,
  );
  assert.equal(blocked.exitCode, 20);
  assert.equal(JSON.parse(blocked.stdout).verdict, 'BLOCKED');
});

test('runMain panel quorum failure is no-judgment exit 30 with structured panel evidence', async () => {
  for (const [judgments, abstentions] of [[0, 2], [1, 1]]) {
    const result = fakePanelEnvelope({ verdict: null, judgments, abstentions });
    const run = await runFakeMain(
      ['--model', DEEPSEEK_PRO_MODEL, '--task', 't', '--require-verdict', '--panel', '--json'],
      async () => result,
    );
    const response = JSON.parse(run.stdout);
    assert.equal(run.exitCode, 30);
    assert.equal(response.outcome, 'no-judgment');
    assert.equal(response.verdict, null);
    assert.equal(response.reason, 'quorum_failure');
    assert.equal(response.mechanism, 'PANEL_QUORUM_FAILURE');
    assert.equal(response.consensus.judgments_count, judgments);
    assert.equal(response.consensus.abstentions_count, abstentions);
    assert.match(run.stderr, /ocask error: panel quorum failure/);
  }
});

test('real CLI: --no-fallback missing native key falls through to OpenCode with identity preserved', async () => {
  const fixture = await makeFakeOpenCodeCli();
  try {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('ocask.mjs', import.meta.url)),
      '--model', DEEPSEEK_PRO_MODEL,
      '--task', 'Return a verdict.',
      '--require-verdict', '--no-fallback', '--json', '--metadata', fixture.metadataPath,
    ], { encoding: 'utf8', env: fixture.env });
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
    const response = JSON.parse(run.stdout);
    const metadata = JSON.parse(await fs.readFile(fixture.metadataPath, 'utf8'));
    const [opencodeArgs] = await readOpenCodeTrace(fixture.tracePath);
    assert.equal(response.verdict, 'APPROVED');
    assert.equal(metadata.actual_model, DEEPSEEK_PRO_MODEL);
    assert.equal(metadata.actual_transport, 'opencode');
    assert.equal(metadata.identity_preserved, true);
    assert.equal(opencodeArgs[opencodeArgs.indexOf('--model') + 1], identityTransportRoute(DEEPSEEK_PRO_MODEL, 'opencode'));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('real CLI: pinned native wire with missing key is no-judgment our-side', async () => {
  const fixture = await makeFakeOpenCodeCli();
  try {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('ocask.mjs', import.meta.url)),
      '--model', DEEPSEEK_PRO_MODEL,
      '--task', 'Return a verdict.',
      '--provider', 'deepseek', '--require-verdict', '--no-fallback', '--json',
      '--metadata', fixture.metadataPath,
    ], { encoding: 'utf8', env: fixture.env });
    assert.equal(run.status, 30, `exit ${run.status}: ${run.stderr}`);
    const response = JSON.parse(run.stdout);
    const metadata = JSON.parse(await fs.readFile(fixture.metadataPath, 'utf8'));
    assert.equal(response.outcome, 'no-judgment');
    assert.equal(response.verdict, null);
    assert.equal(response.locus, 'our-side');
    assert.equal(response.mechanism, 'AUTH_FAILURE');
    assert.equal(metadata.identity_preserved, false, 'no model ran, so identity cannot be claimed');
    await assert.rejects(fs.access(fixture.tracePath), error => error.code === 'ENOENT');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('real CLI: default-mode model swap is surfaced and flips identity_preserved', async () => {
  const fixture = await makeFakeOpenCodeCli('swap-success');
  try {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('ocask.mjs', import.meta.url)),
      '--model', DEEPSEEK_PRO_MODEL,
      '--task', 'Return a verdict.',
      '--require-verdict', '--json', '--metadata', fixture.metadataPath,
    ], { encoding: 'utf8', env: fixture.env });
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
    const response = JSON.parse(run.stdout);
    const metadata = JSON.parse(await fs.readFile(fixture.metadataPath, 'utf8'));
    const traces = await readOpenCodeTrace(fixture.tracePath);
    assert.equal(response.verdict, 'APPROVED');
    assert.equal(metadata.fallback_used, true);
    assert.equal(metadata.actual_model, QWEN_MAX_MODEL);
    assert.equal(metadata.actual_transport, 'opencode');
    assert.equal(metadata.identity_preserved, false);
    // #45: a MODEL_OUTPUT failure now triggers MODEL_OUTPUT_RETRIES (2) same-model
    // retries before the cross-model swap, so the trace is 3x primary then the fallback.
    assert.deepEqual(traces.map(args => args[args.indexOf('--model') + 1]), [
      identityTransportRoute(DEEPSEEK_PRO_MODEL, 'opencode'),
      identityTransportRoute(DEEPSEEK_PRO_MODEL, 'opencode'),
      identityTransportRoute(DEEPSEEK_PRO_MODEL, 'opencode'),
      `alibaba/${QWEN_MAX_MODEL}`,
    ]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('#45: a transient MODEL_OUTPUT is recovered by a same-model retry (no cross-model swap)', async () => {
  const fixture = await makeFakeOpenCodeCli('retry-recovers');
  try {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('ocask.mjs', import.meta.url)),
      '--model', DEEPSEEK_PRO_MODEL,
      '--task', 'Return a verdict.',
      '--require-verdict', '--json', '--metadata', fixture.metadataPath,
    ], { encoding: 'utf8', env: fixture.env });
    assert.equal(run.status, 20, `exit ${run.status}: ${run.stderr}`);
    const response = JSON.parse(run.stdout);
    const metadata = JSON.parse(await fs.readFile(fixture.metadataPath, 'utf8'));
    const traces = await readOpenCodeTrace(fixture.tracePath);
    assert.equal(response.verdict, 'BLOCKED');
    // Same model twice (primary fail + retry success); NO cross-model fallback.
    assert.equal(metadata.fallback_used, false);
    assert.equal(metadata.actual_model, DEEPSEEK_PRO_MODEL);
    assert.deepEqual(traces.map(args => args[args.indexOf('--model') + 1]), [
      identityTransportRoute(DEEPSEEK_PRO_MODEL, 'opencode'),
      identityTransportRoute(DEEPSEEK_PRO_MODEL, 'opencode'),
    ]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('real CLI: failed default-mode model swap remains identity_preserved=false', async () => {
  const fixture = await makeFakeOpenCodeCli('swap-failure');
  try {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('ocask.mjs', import.meta.url)),
      '--model', DEEPSEEK_PRO_MODEL,
      '--task', 'Return a verdict.',
      '--require-verdict', '--json', '--metadata', fixture.metadataPath,
    ], { encoding: 'utf8', env: fixture.env });
    assert.equal(run.status, 30, `exit ${run.status}: ${run.stderr}`);
    const response = JSON.parse(run.stdout);
    const metadata = JSON.parse(await fs.readFile(fixture.metadataPath, 'utf8'));
    assert.equal(response.outcome, 'no-judgment');
    assert.equal(response.verdict, null);
    assert.equal(metadata.fallback_used, true);
    assert.equal(metadata.actual_model, QWEN_MAX_MODEL);
    assert.equal(metadata.actual_transport, 'opencode');
    assert.equal(metadata.identity_preserved, false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('real CLI: --panel emits unanimous cross-family consensus and is never silent', async () => {
  const fixture = await makeFakeOpenCodeCli();
  try {
    const run = spawnSync(process.execPath, [fixture.ocaskPath,
      '--model', DEEPSEEK_PRO_MODEL,
      '--task', 'Output exactly a valid approved verdict with rationale.',
      '--require-verdict', '--panel', '--provider', 'opencode', '--json',
    ], { encoding: 'utf8', env: fixture.env });
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
    assert.ok(Buffer.byteLength(run.stdout, 'utf8') + Buffer.byteLength(run.stderr, 'utf8') > 0, 'rc=0 must never be silent');
    const response = JSON.parse(run.stdout);
    assert.equal(response.outcome, 'judgment');
    assert.equal(response.verdict, 'APPROVED');
    assert.equal(response.consensus.agreement, true);
    assert.equal(response.consensus.judgments_count, 2);
    assert.deepEqual(new Set(response.members.map(member => member.model)), new Set([DEEPSEEK_PRO_MODEL, QWEN_MODEL]));
    const traces = await readOpenCodeTrace(fixture.tracePath);
    assert.deepEqual(new Set(traces.map(args => args[args.indexOf('--model') + 1])), new Set([
      identityTransportRoute(DEEPSEEK_PRO_MODEL, 'opencode'),
      identityTransportRoute(QWEN_MODEL, 'opencode'),
    ]));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('real CLI: --panel --risk trivial is solo while default/high reach OpenCode without native keys', async () => {
  for (const [risk, expectedCalls, expectsPanel] of [
    ['trivial', 1, false],
    ['default', 2, true],
    ['high', 2, true],
  ]) {
    const fixture = await makeFakeOpenCodeCli();
    try {
      const run = spawnSync(fixture.ocaskPath, [
        '--model', DEEPSEEK_PRO_MODEL,
        '--task', 'Output exactly a valid approved verdict with rationale.',
        '--require-verdict', '--panel', '--risk', risk, '--provider', 'opencode', '--json',
      ], { encoding: 'utf8', env: fixture.env });
      assert.equal(run.status, 0, `${risk} exit ${run.status}: ${run.stderr}`);
      const stdoutBytes = Buffer.byteLength(run.stdout, 'utf8');
      const stderrBytes = Buffer.byteLength(run.stderr, 'utf8');
      assert.ok(stdoutBytes > 0, `${risk} rc=0 must include stdout`);
      assert.ok(stdoutBytes + stderrBytes > 0, `${risk} rc=0 must never be silent`);
      const response = JSON.parse(run.stdout);
      assert.equal(response.verdict, 'APPROVED');
      assert.equal(Object.hasOwn(response, 'consensus'), expectsPanel);
      assert.equal(Object.hasOwn(response, 'members'), expectsPanel);
      if (expectsPanel) {
        assert.deepEqual(response.members.map(member => member.model), [DEEPSEEK_PRO_MODEL, QWEN_MODEL]);
        assert.ok(response.members.every(member => member.transport === 'opencode'));
        assert.equal(response.consensus.judgments_count, 2);
      }
      const traces = await readOpenCodeTrace(fixture.tracePath);
      assert.equal(traces.length, expectedCalls);
      if (risk === 'high') {
        const prompts = await readOpenCodePrompts(fixture.promptTracePath);
        assert.equal(prompts.length, 2);
        assert.ok(prompts.every(prompt => prompt.includes('Injection surfaces')));
        assert.ok(prompts.every(prompt => prompt.includes('Correctness')));
        assert.ok(prompts.every(prompt => prompt.includes('Module boundaries')));
      }
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('installed CLI: --risk trivial preserves BLOCKED and failure exit bands', async () => {
  for (const [mode, expectedStatus, expectedOutcome] of [
    ['blocked', 20, 'judgment'],
    ['failure', 30, 'no-judgment'],
  ]) {
    const fixture = await makeFakeOpenCodeCli(mode);
    try {
      const run = spawnSync(fixture.ocaskPath, [
        '--model', DEEPSEEK_PRO_MODEL,
        '--task', 'Return a controlled review result.',
        '--require-verdict', '--panel', '--risk', 'trivial', '--provider', 'opencode', '--json',
      ], { encoding: 'utf8', env: fixture.env });
      const stdoutBytes = Buffer.byteLength(run.stdout, 'utf8');
      const stderrBytes = Buffer.byteLength(run.stderr, 'utf8');
      assert.equal(run.status, expectedStatus, `${mode} exit ${run.status}: ${run.stderr}`);
      assert.ok(stdoutBytes > 0, `${mode} must include structured stdout`);
      assert.ok(stdoutBytes + stderrBytes > 0, `${mode} must never be silent`);
      const response = JSON.parse(run.stdout);
      assert.equal(response.outcome, expectedOutcome);
      assert.equal(Object.hasOwn(response, 'consensus'), false);
      assert.equal(Object.hasOwn(response, 'members'), false);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('installed-symlink CLI: --panel timeout shares one wall-clock and returns quorum failure', async () => {
  const fixture = await makeFakeOpenCodeCli('slow');
  try {
    const startedAt = Date.now();
    const run = spawnSync(process.execPath, [fixture.ocaskPath,
      '--model', DEEPSEEK_PRO_MODEL,
      '--task', 'Return a verdict after waiting.',
      '--require-verdict', '--panel', '--provider', 'opencode', '--timeout-ms', '100', '--json',
    ], { encoding: 'utf8', env: fixture.env });
    const durationMs = Date.now() - startedAt;
    assert.equal(run.status, 30, `exit ${run.status}: ${run.stderr}`);
    assert.ok(durationMs < 900, `parallel panel exceeded shared deadline: ${durationMs}ms`);
    const response = JSON.parse(run.stdout);
    assert.equal(response.outcome, 'no-judgment');
    assert.equal(response.reason, 'quorum_failure');
    assert.equal(response.consensus.judgments_count, 0);
    assert.equal(response.consensus.abstentions_count, 2);
    assert.match(run.stderr, /ocask error: panel quorum failure/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('installed-symlink CLI: existing --cross-verify buddy path remains operational', async () => {
  const fixture = await makeFakeOpenCodeCli('cross');
  try {
    const run = spawnSync(process.execPath, [fixture.ocaskPath,
      '--model', QWEN_MODEL,
      '--task', 'Return an approved verdict.',
      '--require-verdict', '--cross-verify', '--provider', 'opencode', '--json',
    ], { encoding: 'utf8', env: fixture.env });
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
    assert.ok(Buffer.byteLength(run.stdout, 'utf8') > 0);
    assert.equal(JSON.parse(run.stdout).verdict, 'APPROVED');
    const traces = await readOpenCodeTrace(fixture.tracePath);
    assert.deepEqual(new Set(traces.map(args => args[args.indexOf('--model') + 1])), new Set([
      identityTransportRoute(QWEN_MODEL, 'opencode'),
      identityTransportRoute(DEEPSEEK_PRO_MODEL, 'opencode'),
    ]));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('post-invocation validation failure retains the actual provider attribution', async () => {
  await assert.rejects(
    runAsk({
      model: DEEPSEEK_PRO_MODEL,
      taskText: 'Return a verdict.',
      requireVerdict: true,
      noFallback: true,
      invokeWithFallbackFn: async () => ({
        provider: 'opencode',
        model_used: DEEPSEEK_PRO_MODEL,
        stdout: JSON.stringify({ type: 'text', part: { type: 'text', text: 'missing verdict' }, timestamp: Date.now() }),
      }),
    }),
    error => {
      assert.equal(error.ocaskMetadata.actual_model, DEEPSEEK_PRO_MODEL);
      assert.equal(error.ocaskMetadata.actual_transport, 'opencode');
      assert.equal(error.ocaskMetadata.identity_preserved, true);
      return true;
    },
  );
});

test('successful but untrusted transport is never attributed as identity-preserving', async () => {
  const result = await runAsk({
    model: DEEPSEEK_PRO_MODEL,
    taskText: 'Return a verdict.',
    requireVerdict: true,
    noFallback: false,
    invokeWithFallbackFn: async () => ({
      provider: 'misconfigured-transport',
      model_used: DEEPSEEK_PRO_MODEL,
      stdout: JSON.stringify({ type: 'text', part: { type: 'text', text: 'VERDICT: APPROVED\n\nUntrusted path.' }, timestamp: Date.now() }),
      stderr: '',
    }),
  });
  assert.equal(result.metadata.identity_preserved, false);
});

// A runAsk fake shaped exactly like the real success envelope: output + verdict +
// classification + metadata + run_id. main() never calls a provider.
function fakeJudgment(verdict, text) {
  return async () => ({
    output: text, model: QWEN_MODEL, verdict,
    classification: { class: 'judgment', subclass: null, locus: null, mechanism: null },
    metadata: {}, run_id: 'fake',
  });
}

function fakePanelEnvelope({ verdict, judgments, abstentions }) {
  const failed = verdict === null;
  const classification = failed
    ? { class: 'no-judgment', subclass: 'indeterminate', locus: null, mechanism: 'PANEL_QUORUM_FAILURE' }
    : classifyFailure(null, { verdict });
  const members = [
    {
      model: DEEPSEEK_PRO_MODEL, transport: 'opencode',
      verdict: judgments >= 1 ? (verdict || 'APPROVED') : null,
      classification: judgments >= 1 ? classifyFailure(null, { verdict: verdict || 'APPROVED' }) : panelAbstention(DEEPSEEK_PRO_MODEL).classification,
      output_preview: '',
    },
    {
      model: QWEN_MAX_MODEL, transport: 'opencode',
      verdict: judgments >= 2 ? (verdict || 'APPROVED') : null,
      classification: judgments >= 2 ? classifyFailure(null, { verdict: verdict || 'APPROVED' }) : panelAbstention(QWEN_MAX_MODEL).classification,
      output_preview: '',
    },
  ];
  return {
    ok: true,
    failed,
    output: verdict ? `VERDICT: ${verdict}\n\nPanel consensus.` : 'PANEL NO-JUDGMENT\n\nReason: quorum_failure.',
    verdict,
    classification,
    consensus: {
      verdict, agreement: verdict !== null, judgments_count: judgments,
      abstentions_count: abstentions, degraded: failed, k: 2, n: 2,
    },
    members,
    metadata: {},
    run_id: 'fake-panel',
    cross_verify: null,
  };
}

async function runFakeMain(argv, fakeRunAsk, capture = { stdout: [], stderr: [] }, env = process.env) {
  const prev = process.exitCode;
  await runMain(argv,
    (l) => capture.stdout.push(l), (l) => capture.stderr.push(l),
    process.stdin, process.cwd(), env, fakeRunAsk);
  const out = capture.stdout.join('');
  const restored = process.exitCode;
  process.exitCode = prev;
  return { exitCode: restored, stdout: out, stderr: capture.stderr.join('') };
}

test('scrubMessage strips fake DEEPSEEK_API_KEY from mechanism payload while preserving context', async () => {
  const secret = 'sk-live-fake-key-1234567890';
  const text = `DeepSeek API error: invalid credentials ${secret} for model deepseek-v4-flash`;
  const out = await scrubMessage(text, { DEEPSEEK_API_KEY: secret, QWEN_API_KEY: '' });
  assert.equal(out.includes(secret), false, 'secret token must be removed');
  assert.equal(out.includes('DEEPSEEK_API_KEY'), false);
  assert.match(out, /\[redacted:own-key-[0-9a-f]{8}\]/);
  assert.match(out, /invalid credentials/);
  assert.match(out, /deepseek-v4-flash/);
});

test('issue22: scrubMessage strips standard base64 derived from a known synthetic secret', async () => {
  const secret = 'synthetic-ÿÿ-secretx';
  const encoded = Buffer.from(secret).toString('base64');
  const out = await scrubMessage(`upstream echoed ${encoded}`, { DEEPSEEK_API_KEY: secret });
  assert.equal(out.includes(encoded), false, 'known-secret base64 must be removed');
  assert.match(out, /\[redacted:own-key-[0-9a-f]{8}\]/);
});

test('issue22: scrubMessage strips padded and unpadded base64url derived from a known synthetic secret', async () => {
  const secret = 'synthetic-ÿÿ-secretx';
  const standard = Buffer.from(secret).toString('base64');
  const padded = standard.replace(/\+/g, '-').replace(/\//g, '_');
  const unpadded = Buffer.from(secret).toString('base64url');
  const out = await scrubMessage(`padded=${padded} unpadded=${unpadded}`, { DEEPSEEK_API_KEY: secret });
  assert.equal(out.includes(padded), false, 'known-secret padded base64url must be removed');
  assert.equal(out.includes(unpadded), false, 'known-secret unpadded base64url must be removed');
});

test('issue22: scrubMessage strips encodeURIComponent output and still strips the raw secret', async () => {
  const secret = 'synthetic secret/value?x=1';
  const encoded = encodeURIComponent(secret);
  const out = await scrubMessage(`encoded=${encoded} raw=${secret}`, { DEEPSEEK_API_KEY: secret });
  assert.equal(out.includes(encoded), false, 'known-secret percent encoding must be removed');
  assert.equal(out.includes(secret), false, 'known-secret raw value must remain covered');
});

test('issue22: scrubMessage leaves unrelated novel encodings alone', async () => {
  const secret = 'synthetic-known-secret-123';
  const unrelatedEncoding = Buffer.from(secret).toString('hex');
  const text = `novel=${unrelatedEncoding}`;
  const out = await scrubMessage(text, { DEEPSEEK_API_KEY: secret });
  assert.equal(out, text, 'only explicitly derived supported encodings are scrubbed');
});

test('issue22: an encoding failure preserves scrubMessage default-deny behavior', async () => {
  const invalidForEncodeURIComponent = '\ud800'.repeat(8);
  const out = await scrubMessage('synthetic provider failure', {
    DEEPSEEK_API_KEY: invalidForEncodeURIComponent,
  });
  assert.equal(out, '[scrubbed:unavailable]');
});

test('scrubMessage returns placeholder when scrubbing fails', async () => {
  const secret = 'sk-live-fake-key-1234567890';
  const text = `DeepSeek API error: invalid credentials ${secret}`;
  const out = await scrubMessage(text, { DEEPSEEK_API_KEY: secret, QWEN_API_KEY: '' }, {
    createHashImpl: () => { throw new Error('crypto unavailable'); },
  });
  assert.equal(out, '[scrubbed:unavailable]');
  assert.equal(out.includes(secret), false, 'placeholder must replace raw message');
});

test('scrubMessage enforces a max mechanism-message length and marks truncation', async () => {
  const out = await scrubMessage('A'.repeat(250));
  assert.equal(out.length, MAX_MECHANISM_MSG_LENGTH);
  assert.equal(out.endsWith('…[truncated]'), true);

  const exactly = 'B'.repeat(MAX_MECHANISM_MSG_LENGTH);
  const stable = await scrubMessage(exactly);
  assert.equal(stable.length, MAX_MECHANISM_MSG_LENGTH);
  assert.equal(stable.endsWith('…[truncated]'), false);
});

test('scrubMessage strips a secret that straddles the 200-char boundary', async () => {
  const secret = 'sk-live-fake-boundary-key-123456';
  const text = `${'A'.repeat(196)}${secret}:tail`;
  const out = await scrubMessage(text, { DEEPSEEK_API_KEY: secret, QWEN_API_KEY: '' });
  assert.equal(out.includes(secret), false);
  assert.equal(out.includes(secret.slice(0, 8)), false);
});

test('main(): APPROVED verdict -> exit 0 + verdict in json', async () => {
  const { exitCode, stdout } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--require-verdict', '--json'],
    fakeJudgment('APPROVED', 'VERDICT: APPROVED\n\nLooks good.'));
  const obj = JSON.parse(stdout);
  assert.equal(exitCode, 0);
  assert.equal(obj.outcome, 'judgment');
  assert.equal(obj.verdict, 'APPROVED');
  assert.equal(obj.exit_code, 0);
});

test('main(): WARNING verdict -> exit 0 (proceed), distinguished only in json verdict', async () => {
  const { exitCode, stdout } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--require-verdict', '--json'],
    fakeJudgment('WARNING', 'VERDICT: WARNING\n\nMinor issue.'));
  const obj = JSON.parse(stdout);
  assert.equal(exitCode, 0);
  assert.equal(obj.verdict, 'WARNING');
  assert.equal(obj.exit_code, 0);
});

test('main(): BLOCKED verdict -> exit 20', async () => {
  const { exitCode, stdout } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--require-verdict', '--json'],
    fakeJudgment('BLOCKED', 'VERDICT: BLOCKED\n\nMust fix.'));
  const obj = JSON.parse(stdout);
  assert.equal(exitCode, 20);
  assert.equal(obj.verdict, 'BLOCKED');
  assert.equal(obj.exit_code, 20);
});

test('main(): non-json BLOCKED still prints the human text and exits 20', async () => {
  const { exitCode, stdout } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--require-verdict'],
    fakeJudgment('BLOCKED', 'VERDICT: BLOCKED\n\nMust fix.'));
  assert.equal(exitCode, 20);
  assert.match(stdout, /VERDICT: BLOCKED/);
});

test('main(): forced AUTH_FAILURE -> exit 30, verdict:null, reason/locus/mechanism set', async () => {
  const authError = Object.assign(
    new ProviderError('DEEPSEEK_API_KEY not set', 'AUTH_FAILURE'),
    { code: 'AUTH_FAILURE', provider: 'deepseek' },
  );
  const { exitCode, stdout, stderr } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--require-verdict', '--json'],
    async () => { throw authError; });
  const obj = JSON.parse(stdout);
  assert.equal(exitCode, 30);
  assert.equal(obj.outcome, 'no-judgment');
  assert.equal(obj.verdict, null);
  assert.equal(obj.reason, 'reply-absent');
  assert.equal(obj.locus, 'our-side');
  assert.equal(obj.mechanism, 'AUTH_FAILURE');
  assert.equal(obj.exit_code, 30);
  // Human stderr line is still emitted for non-json callers.
  assert.match(stderr, /ocask error:/);
});

test('main(): a no-judgment run never exits 0 and never emits a non-null verdict', async () => {
  const timeoutError = Object.assign(
    new ProviderError('timed out', 'TIMEOUT'),
    { code: 'TIMEOUT', provider: 'deepseek' },
  );
  const { exitCode, stdout } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--require-verdict', '--json'],
    async () => { throw timeoutError; });
  const obj = JSON.parse(stdout);
  assert.notEqual(exitCode, 0, 'no-judgment must never exit 0');
  assert.equal(exitCode, 30);
  assert.equal(obj.verdict, null, 'no-judgment must never carry a verdict');
  assert.equal(obj.outcome, 'no-judgment');
});

test('main(): freeform success (no --require-verdict) -> exit 0, verdict:null, not a judgment', async () => {
  const freeform = async () => ({
    output: 'Here is the analysis.', model: QWEN_MODEL, verdict: null,
    classification: null, metadata: {}, run_id: 'fake',
  });
  const { exitCode, stdout } = await runFakeMain(
    ['--model', QWEN_MODEL, '--task', 't', '--json'], freeform);
  const obj = JSON.parse(stdout);
  assert.equal(exitCode, 0, 'freeform success did not fail -> exit 0');
  assert.equal(obj.outcome, 'analysis', 'freeform success is analysis (exit 0), never no-judgment');
  assert.equal(obj.verdict, null);
  assert.equal(obj.exit_code, 0);
  assert.equal(obj.reason, null);
});

// ── issue #10 entailment + tri-state health behavior ──

test('issue10: timeout is inferred as timeout/hang, never credentials auth', () => {
  const attempts = [{
    outcome: 'failed', provider: 'deepseek', model: DEEPSEEK_MODEL,
    mechanism: 'TIMEOUT', class: 'no-judgment', subclass: 'reply-absent',
    locus: 'their-side', duration_ms: 12000, duration_censored: true,
  }];
  const root = _inferRootCause(attempts, [], null, {});
  assert.equal(root.cause.includes('credentials'), false);
  assert.match(root.cause, /deadline|hang|timeout/);
  assert.match(root.fix ?? '', /timeout|hang|investigate|trial|swit/);
});

test('issue10: a classified HTTP 429 is inferred as rate-limited on our side', () => {
  const origin = Object.assign(
    new ProviderError('rate limited', 'RATE_LIMITED'),
    { code: 'RATE_LIMITED', provider: 'qwen', status: 429 },
  );
  const classification = classifyFailure(wrapAsExhausted(origin));
  const attempts = [{
    outcome: 'failed', provider: 'qwen', model: QWEN_MODEL,
    ...classification,
  }];
  const root = _inferRootCause(attempts, [], null, {});
  assert.equal(classification.locus, 'our-side');
  assert.match(root.cause, /rate-limited \(our-side\)/i);
  assert.notEqual(root.cause, 'undetermined');
});

test('issue10: billing cause requires ENTITLEMENT/402 evidence for that provider only', () => {
  const provider = {
    provider_model: 'deepseek/deepseek-v4-flash',
    total: 1,
    success: 0,
    success_rate: '0.0%',
    avg_latency_ms: 0,
    uncensored_latency_count: 0,
    healthy_p99_ms: null,
    failure_buckets: [{
      provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'TIMEOUT', class: 'no-judgment',
      subclass: 'reply-absent', locus: 'their-side', http_status: null,
      count: 1, maxDurationMs: 120000, avgDurationMs: 120000, durationSamples: [120000], durationCensored: 1, evidenceCount: 1,
    }],
  };
  const timeoutSuggestion = generateSuggestions([provider], []);
  assert.ok(timeoutSuggestion.some(a => /timeout/.test(a.action) && !/billing|quota|credits/.test(a.action)));

  const billed = {
    ...provider,
    failure_buckets: [{
      provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'ENTITLEMENT_UNAVAILABLE', class: 'no-judgment',
      subclass: 'reply-absent', locus: 'their-side', http_status: 402,
      count: 1, maxDurationMs: 0, avgDurationMs: 0, durationSamples: [], durationCensored: 0, evidenceCount: 1,
    }],
  };
  const billingSuggestion = generateSuggestions([billed], []);
  assert.ok(billingSuggestion.some(a => /billing\/quota/.test(a.action) || /billing/.test(a.action)));
});

test('issue10: probe status mapping keeps HTTP 401 as warn, 200 as warn (trial-only)', () => {
  const unauthorized = connectivityStatusFromHttp(401);
  const ok = connectivityStatusFromHttp(200);
  assert.equal(unauthorized.status, 'warn');
  assert.equal(locusFromStatus(401), 'our-side');
  assert.equal(ok.status, 'warn');
  assert.equal(ok.locus, null);
});

test('issue10: timeout hang fix explicitly says do NOT increase timeout', () => {
  const attempts = [
    { outcome: 'success', provider: 'deepseek', model: DEEPSEEK_MODEL, duration_ms: 8000 },
    { outcome: 'failed', provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'TIMEOUT',
      class: 'no-judgment', subclass: 'reply-absent', locus: 'their-side', duration_ms: 300000, duration_censored: true,
      http_status: null, reason_code: 'TIMEOUT' },
  ];
  const root = _inferRootCause(attempts, [], null, {});
  assert.equal(root.cause.includes('HANG'), true);
  assert.match(root.fix, /Do NOT increase --timeout-ms/i);
});

test('issue10: doctor suggestions path reaches HANG for a censored bucket ≫ P99 (not only diagnoseRun)', () => {
  // Regression: doctorReport buckets carry maxDurationMs + a censored COUNT, not the
  // per-attempt duration_ms/duration_censored that _inferFailureFinding reads. Without the
  // field bridge, generateSuggestions never reaches the hang branch and mis-advises
  // "Increase --timeout-ms" on a real hang. This asserts the doctor path, not _inferRootCause.
  const provider = {
    provider_model: 'deepseek/deepseek-v4-pro',
    total: 1, success: 0, success_rate: '0.0%',
    avg_latency_ms: 0, uncensored_latency_count: 0,
    healthy_p99_ms: 109000,
    failure_buckets: [{
      provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'TIMEOUT', class: 'no-judgment',
      subclass: 'reply-absent', locus: 'their-side', http_status: null,
      count: 1, maxDurationMs: 314359, avgDurationMs: 314359, durationSamples: [314359],
      durationCensored: 1, evidenceCount: 1,
    }],
  };
  const suggestions = generateSuggestions([provider], []);
  assert.ok(suggestions.some(a => /HANG/i.test(a.action)), 'doctor path must classify a censored ≫P99 timeout as HANG');
  assert.ok(suggestions.some(a => /Do NOT increase --timeout-ms/i.test(a.action)), 'hang advice must forbid increasing the timeout');
  assert.equal(suggestions.some(a => /HANG/i.test(a.action) && /\bIncrease --timeout-ms\b/.test(a.action)), false);
});

test('issue10: HANG guidance never coexists with advice to increase timeout', () => {
  const provider = {
    provider_model: 'deepseek/deepseek-v4-pro',
    total: 2, success: 1, success_rate: '50.0%',
    avg_latency_ms: 45000, uncensored_latency_count: 1,
    healthy_p99_ms: 10000,
    failure_buckets: [{
      provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'TIMEOUT', class: 'no-judgment',
      subclass: 'reply-absent', locus: 'their-side', http_status: null,
      count: 1, maxDurationMs: 120000, avgDurationMs: 120000, durationSamples: [120000],
      durationCensored: 1, evidenceCount: 1,
    }],
  };
  const suggestions = generateSuggestions([provider], []);
  const hangAction = suggestions.find(a => /Do NOT increase --timeout-ms/i.test(a.action));
  assert.ok(hangAction);
  assert.equal(suggestions.some(a => a !== hangAction && /increase\b.*timeout|increasing timeout/i.test(a.action)), false);
});

test('issue10: latency advice excludes censored samples from averaged advice threshold', () => {
  const provider = {
    provider_model: 'deepseek/deepseek-v4-flash',
    total: 1,
    success: 0,
    success_rate: '0.0%',
    avg_latency_ms: 45000,
    uncensored_latency_count: 0,
    healthy_p99_ms: null,
    failure_buckets: [{
      provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'TIMEOUT', class: 'no-judgment',
      subclass: 'reply-absent', locus: 'their-side', http_status: null,
      count: 1, maxDurationMs: 120000, avgDurationMs: 120000, durationSamples: [120000], durationCensored: 1, evidenceCount: 1,
    }],
  };
  const suggestions = generateSuggestions([provider], []);
  assert.equal(suggestions.some(a => /uncensored avg latency/i.test(a.action)), false);
});

test('issue10: no cross-provider billing hint for deepseek failure', () => {
  const provider = {
    provider_model: 'deepseek/deepseek-v4-flash',
    total: 1,
    success: 0,
    success_rate: '0.0%',
    avg_latency_ms: 1000,
    uncensored_latency_count: 1,
    healthy_p99_ms: null,
    failure_buckets: [{
      provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'TIMEOUT', class: 'no-judgment',
      subclass: 'reply-absent', locus: 'their-side', http_status: null,
      count: 1, maxDurationMs: 1000, avgDurationMs: 1000, durationSamples: [1000], durationCensored: 0, evidenceCount: 1,
    }],
  };
  const suggestions = generateSuggestions([provider], []);
  assert.equal(suggestions.some(a => /OpenCode Go/i.test(a.action)), false);
});

test('issue10: mixed failure set is bucketed and not collapsed', () => {
  const provider = {
    provider_model: 'deepseek/deepseek-v4-flash',
    total: 2,
    success: 0,
    success_rate: '0.0%',
    avg_latency_ms: 1000,
    uncensored_latency_count: 1,
    healthy_p99_ms: 800,
    failure_buckets: [
      {
        provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'TIMEOUT', class: 'no-judgment',
        subclass: 'reply-absent', locus: 'their-side', http_status: null,
        count: 1, maxDurationMs: 1000, avgDurationMs: 1000, durationSamples: [1000], durationCensored: 1, evidenceCount: 1,
      },
      {
        provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'AUTH_FAILURE', class: 'no-judgment',
        subclass: 'reply-absent', locus: 'our-side', http_status: 401,
        count: 1, maxDurationMs: 100, avgDurationMs: 100, durationSamples: [100], durationCensored: 0, evidenceCount: 1,
      },
    ],
  };
  const suggestions = generateSuggestions([provider], []);
  const timeoutRows = suggestions.filter(a => /TIMEOUT|deadline|hang|timeout/i.test(a.action)).length;
  const authRows = suggestions.filter(a => /AUTH_FAILURE|auth|credentials|api key/i.test(a.action)).length;
  assert.ok(timeoutRows >= 1, 'timeout failure should produce a timeout finding');
  assert.ok(authRows >= 1, 'auth failure should produce an auth finding');
  assert.ok(suggestions.length >= 2);
});

test('issue10: consistency does not imply entailment → undetermined cause', () => {
  const attempts = [{
    outcome: 'failed', provider: 'deepseek', model: DEEPSEEK_MODEL, mechanism: 'PROVIDER_ERROR',
    class: 'no-judgment', subclass: 'reply-absent', locus: 'their-side', duration_ms: 1500,
  }];
  const root = _inferRootCause(attempts, [], null, {});
  assert.equal(root.cause, 'undetermined');
  assert.match(root.fix, /Observed:/);
});

test('issue10: no evidence does not emit a cause', () => {
  const attempts = [{
    outcome: 'failed', provider: 'deepseek', model: DEEPSEEK_MODEL,
    class: 'no-judgment', subclass: 'indeterminate', locus: null, duration_ms: 0,
  }];
  const root = _inferRootCause(attempts, [], null, {});
  assert.equal(root.cause, 'undetermined');
});

test('issue10: no attempt records and no terminal error is undetermined', () => {
  const root = _inferRootCause([], [], null, {});
  assert.equal(root.cause, 'undetermined');
  assert.match(root.fix, /no attempt records and no terminal error/i);
});

test('issue10: terminal error without failed attempts is observed but undetermined', () => {
  const root = _inferRootCause([], [], { error_code: 'SPAWN' }, {});
  assert.equal(root.cause, 'undetermined');
  assert.match(root.fix, /SPAWN/);
});

test('issue10: _inferRootCause with two distinct mechanisms yields undetermined', () => {
  const attempts = [
    {
      outcome: 'failed',
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      mechanism: 'TIMEOUT',
      class: 'no-judgment',
      subclass: 'reply-absent',
      locus: 'their-side',
      duration_ms: 314359,
      duration_censored: true,
      http_status: null,
    },
    {
      outcome: 'failed',
      provider: 'qwen',
      model: QWEN_MODEL,
      mechanism: 'AUTH_FAILURE',
      class: 'no-judgment',
      subclass: 'reply-absent',
      locus: 'our-side',
      duration_ms: 1000,
      duration_censored: false,
      http_status: 401,
    },
  ];
  const root = _inferRootCause(attempts, [], null, {});
  assert.equal(root.cause, 'undetermined');
  assert.match(root.fix ?? '', /Observed:/);
  assert.match(root.fix ?? '', /TIMEOUT/);
  assert.match(root.fix ?? '', /AUTH_FAILURE/);
});

test('issue10: INSUFFICIENT_BALANCE without a 402 signal is undetermined, not billing', () => {
  const provider = {
    provider_model: 'deepseek/deepseek-v4-flash',
    total: 1,
    success: 0,
    success_rate: '0.0%',
    avg_latency_ms: 0,
    uncensored_latency_count: 0,
    healthy_p99_ms: null,
    failure_buckets: [{
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      mechanism: 'INSUFFICIENT_BALANCE',
      class: 'no-judgment',
      subclass: 'reply-absent',
      locus: 'our-side',
      http_status: null,
      count: 1,
      maxDurationMs: 0,
      avgDurationMs: 0,
      durationSamples: [0],
      durationCensored: 0,
      evidenceCount: 1,
    }],
  };
  const suggestions = generateSuggestions([provider], []);
  assert.equal(suggestions.some(a => /billing|quota|credit/i.test(a.action)), false);
  assert.equal(suggestions.some(a => /undetermined/i.test(a.action)), true);
});

test('issue10: doctorReport end-to-end pipeline reaches HANG through real buckets', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-doctor-report-'));
  const prevXdg = process.env.XDG_DATA_HOME;
  const logDir = path.join(tmp, 'ocask');
  const logPath = path.join(logDir, 'log.jsonl');
  process.env.XDG_DATA_HOME = tmp;

  const lines = [
    {
      event: 'attempt.result',
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      outcome: 'success',
      mechanism: 'SUCCESS',
      class: 'judgment',
      subclass: 'approved',
      locus: null,
      duration_ms: 95000,
      duration_censored: false,
      http_status: 200,
      tokens_used: 42,
    },
    {
      event: 'attempt.result',
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      outcome: 'success',
      mechanism: 'SUCCESS',
      class: 'judgment',
      subclass: 'approved',
      locus: null,
      duration_ms: 100000,
      duration_censored: false,
      http_status: 200,
      tokens_used: 42,
    },
    {
      event: 'attempt.result',
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      outcome: 'success',
      mechanism: 'SUCCESS',
      class: 'judgment',
      subclass: 'approved',
      locus: null,
      duration_ms: 109000,
      duration_censored: false,
      http_status: 200,
      tokens_used: 42,
    },
    {
      event: 'attempt.result',
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      outcome: 'failed',
      mechanism: 'TIMEOUT',
      class: 'no-judgment',
      subclass: 'reply-absent',
      locus: 'their-side',
      duration_ms: 314359,
      duration_censored: true,
      http_status: null,
      tokens_used: null,
    },
  ];

  const payload = lines.map((x) => JSON.stringify(x)).join('\n');
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(logPath, payload, 'utf8');

    const report = await doctorReport({ system: false });
    const deepseekProvider = report.providers.find((p) => p.provider === 'deepseek' || `${p.provider_model ?? ''}`.startsWith('deepseek'));
    assert.equal(Array.isArray(deepseekProvider?.failure_buckets), true, 'deepseek provider should include failure buckets array');
    assert.ok(deepseekProvider.failure_buckets.length > 0, 'deepseek failure bucket should exist');

    const suggestions = report.suggestions;
    assert.ok(
      suggestions.some((s) => /HANG/i.test(s.action)),
      'doctor suggestion should classify this as HANG',
    );
    assert.ok(
      suggestions.some((s) => /Do NOT increase --timeout-ms/i.test(s.action)),
      'hang guidance should avoid increasing timeout',
    );
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('issue10: locusFromStatus mapping', () => {
  assert.equal(locusFromStatus(401), 'our-side');
  assert.equal(locusFromStatus(403), 'our-side');
  assert.equal(locusFromStatus(429), 'our-side');
  assert.equal(locusFromStatus(402), 'their-side'); // #21: billing/entitlement is provider-side
  assert.equal(locusFromStatus(404), 'our-side');   // other 4xx stay our-side (client)
  assert.equal(locusFromStatus(503), 'their-side');
  assert.equal(locusFromStatus(504), 'their-side');
  assert.equal(locusFromStatus(200), null);
});

test('issue10: summarizeChecks keeps pass+warn+fail === total and counts a status-less ok check as pass', () => {
  // Regression: the log-file check is pushed with { ok: true } and NO status. Previously the
  // top-level counts skipped it (no status) while category aggregation defaulted it to fail,
  // so pass+warn+fail < total and "checks passed" was under-counted. Every check must map to
  // exactly one tri-state.
  const checks = [
    { category: 'dependencies', name: 'node', ok: true, status: 'pass' },
    { category: 'auth', name: 'deepseek-auth', ok: false, status: 'fail' },
    { category: 'connectivity', name: 'deepseek-connectivity', ok: false, status: 'warn' },
    { category: 'data', name: 'log-file', ok: true }, // no explicit status → derived from ok
  ];
  const { status, summary } = summarizeChecks(checks);
  assert.equal(summary.pass + summary.warn + summary.fail, summary.total, 'tri-state must partition all checks');
  assert.equal(summary.total, 4);
  assert.equal(summary.pass, 2, 'the status-less ok check counts as pass, not fail');
  assert.equal(summary.warn, 1);
  assert.equal(summary.fail, 1);
  // the data category's single ok check is pass, never fail
  assert.equal(summary.categories.data.status.pass, 1);
  assert.equal(summary.categories.data.status.fail, 0);
  // any fail → unhealthy overall
  assert.equal(status, 'unhealthy');
});

test('issue10: summarizeChecks — warn (no fail) is degraded, all pass is healthy', () => {
  assert.equal(summarizeChecks([{ category: 'a', name: 'x', ok: true, status: 'pass' }]).status, 'healthy');
  assert.equal(summarizeChecks([
    { category: 'a', name: 'x', ok: true, status: 'pass' },
    { category: 'c', name: 'y', ok: false, status: 'warn' },
  ]).status, 'degraded');
});

test('issue9: stderr cause line is scrubbed of own secrets (Domain 3, ocask.mjs runMain catch)', async () => {
  // Regression for the redactor audit: the human "ocask error: <cause>" line written to stderr must
  // not echo our own key value if a provider error message contains it (e.g. a 401 body). runMain now
  // routes `cause` through scrubMessage(cause) which reads process.env — so set a synthetic key.
  const FAKE = 'sk-fake-domain3-secret-0987654321';
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = FAKE;
  try {
    const cause = `DeepSeek API error: Invalid API key: ${FAKE} (401)`;
    const stderrLine = `ocask error: ${await scrubMessage(cause)}`;
    assert.equal(stderrLine.includes(FAKE), false, 'stderr must not contain the raw key value');
    assert.match(stderrLine, /redacted:own-key-/, 'the secret must be replaced by the redaction marker');
    assert.match(stderrLine, /Invalid API key/, 'non-secret context is preserved');
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test('issue9: longest-first ordering — a longer key overlapping a shorter one is fully scrubbed (no orphan)', async () => {
  // Design §7.1: secrets are matched longest-first so scrubbing a shorter key that is a prefix of a
  // longer key cannot orphan the longer key's suffix. Here QWEN key is a prefix of the DEEPSEEK key.
  const shortKey = 'sk-common-prefix-1234';          // 21 chars, >= MIN_SECRET_LENGTH
  const longKey  = 'sk-common-prefix-1234-SUFFIX-XYZ789'; // longKey starts with shortKey
  const env = { QWEN_API_KEY: shortKey, DEEPSEEK_API_KEY: longKey };
  const out = await scrubMessage(`upstream rejected ${longKey} at edge`, env);
  assert.equal(out.includes(longKey), false, 'the full long key must be removed');
  assert.equal(out.includes('SUFFIX-XYZ789'), false, 'no orphaned suffix of the long key may survive');
});

test('issue9: MIN_SECRET_LENGTH guard — a sub-8-char value is NOT used as a scrub token (no over-scrub)', async () => {
  const tiny = 'abc12';   // 5 chars, below MIN_SECRET_LENGTH (8)
  const env = { DEEPSEEK_API_KEY: tiny, QWEN_API_KEY: '' };
  const out = await scrubMessage(`benign text abc12 and abc12345 tail`, env);
  assert.equal(out.includes('abc12'), true, 'a below-threshold value must not redact its occurrences');
  assert.doesNotMatch(out, /redacted:own-key-/, 'no redaction should occur for a sub-threshold secret');
});

test('issue9: scrub uses the INVOCATION env, not process.env — a secret only in the injected env is scrubbed', async () => {
  // Regression for the redactor Codex review (BLOCKED): logAttemptResult/logError scrubbed against
  // process.env, but ocask invokes providers with an injected env (e.g. the generated opencode server
  // password). A secret present ONLY in that injected env must still be scrubbed in the local record.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-scrubenv-'));
  const prevXdg = process.env.XDG_DATA_HOME, prevKey = process.env.DEEPSEEK_API_KEY;
  process.env.XDG_DATA_HOME = dir;
  delete process.env.DEEPSEEK_API_KEY; // ensure the secret is NOT in process.env
  try {
    const FAKE = 'sk-only-injected-env-99887766';
    await startRun({ model: 'deepseek-v4-pro' });
    await logAttemptResult({
      provider: 'opencode', model: 'deepseek-v4-pro', attemptIndex: 0, outcome: 'failed',
      durationMs: 5, reasonCode: 'AUTH_FAILURE', mechanismMessage: `401 body echoed ${FAKE}`,
      scrubEnv: { DEEPSEEK_API_KEY: FAKE },
    });
    const rec = (await readLog()).find(e => e.event === 'attempt.result');
    assert.equal(JSON.stringify(rec).includes(FAKE), false, 'injected-env secret must not persist in the record');
    assert.match(rec.mechanism_message, /redacted:own-key-/);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
    if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey;
  }
});
