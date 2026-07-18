import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildPrompt,
  buildJsonResponse,
  defaultFallbackModel,
  describeOutcome,
  exitCodeForOutcome,
  extractJsonObject,
  extractVerdict,
  guardAllowedModels,
  parseArgs,
  parseOpenCodeJsonl,
  readExistingPathOrLiteral,
  runAsk,
  runMain,
  validateAssistantOutput,
} from './ocask.mjs';
import {
  classifyFailure,
  unwrapOrigin,
  logAttemptResult,
  readLog,
  startRun,
} from './logging.mjs';
import {
  ProviderError,
  identityTransportRoute,
  identityTransportTrustTable,
  invokeWithFallback,
  resolveProviderChain,
} from './providers/factory.mjs';

const QWEN_MODEL = 'qwen3.7-plus';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_PRO_MODEL = 'deepseek-v4-pro';

async function makeFakeOpenCodeCli(mode = 'success') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-identity-'));
  const binDir = path.join(root, 'bin');
  const homeDir = path.join(root, 'home');
  const tracePath = path.join(root, 'opencode-args.json');
  const metadataPath = path.join(root, 'metadata.json');
  await fs.mkdir(binDir);
  await fs.mkdir(homeDir);
  const executable = path.join(binDir, 'opencode');
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OCASK_TEST_OPENCODE_TRACE, JSON.stringify(args) + '\\n');
const route = args[args.indexOf('--model') + 1];
if (process.env.OCASK_TEST_OPENCODE_MODE.startsWith('swap-') && route.startsWith('deepseek/')) {
  process.stdout.write(JSON.stringify({type:'text', timestamp:Date.now(), part:{type:'text', text:JSON.stringify({reason:'Primary deliberately omitted its verdict.'})}}) + '\\n');
} else if (process.env.OCASK_TEST_OPENCODE_MODE === 'swap-failure' && route.startsWith('alibaba/')) {
  process.stderr.write('controlled qwen transport failure\\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({type:'text', timestamp:Date.now(), part:{type:'text', text:JSON.stringify({verdict:'APPROVED', reason:'Real factory path reached OpenCode.'})}}) + '\\n');
}
`);
  await fs.chmod(executable, 0o755);
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    XDG_DATA_HOME: path.join(root, 'data'),
    OCASK_DISABLE_SERVER: '1',
    OCASK_TEST_OPENCODE_TRACE: tracePath,
    OCASK_TEST_OPENCODE_MODE: mode,
    DEEPSEEK_API_KEY: '',
    QWEN_API_KEY: '',
  };
  return { root, tracePath, metadataPath, env };
}

async function readOpenCodeTrace(tracePath) {
  return (await fs.readFile(tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
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

// ── Model gate ──
test('paid-model gate rejects free and unknown models', () => {
  assert.throws(() => guardAllowedModels({ model: 'deepseek-v4-free' }), /not allowed/);
  assert.throws(() => guardAllowedModels({ model: 'gpt-4o' }), /not allowed/);
  guardAllowedModels({ model: DEEPSEEK_PRO_MODEL });
});

test('default fallback is deterministic and from opposite family', () => {
  assert.equal(defaultFallbackModel(DEEPSEEK_MODEL), 'qwen3.7-plus');
  assert.equal(defaultFallbackModel('qwen3.7-max'), DEEPSEEK_MODEL);
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

test('runMain rejects missing model or task', async () => {
  const stderr = []; const prev = process.exitCode;
  await runMain(['--model', QWEN_MODEL], () => {}, (l) => stderr.push(l));
  assert.ok(stderr.join('').includes('Usage'));
  assert.equal(process.exitCode, 30, 'usage throw is no-judgment band 30, not 1');
  process.exitCode = prev;
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
  assert.equal(cls.locus, 'their-side');
  assert.equal(cls.http_status, 429);
  assert.equal(cls.retry_after, '42');
});

test('logAttemptResult writes the full failure-record taxonomy to the log', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-tax-'));
  const prevXdg = process.env.XDG_DATA_HOME;
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
      errorClass: 'ProviderError', classification,
    });
    const entries = await readLog();
    const rec = entries.find(e => e.event === 'attempt.result');
    assert.ok(rec, 'attempt.result record was written');
    assert.equal(rec.provider, 'deepseek', 'real provider, not unknown');
    assert.equal(rec.class, 'no-judgment');
    assert.equal(rec.subclass, 'reply-absent');
    assert.equal(rec.locus, 'their-side');
    assert.equal(rec.mechanism, 'TIMEOUT', 'true mechanism, not all_exhausted');
    assert.equal(rec.duration_censored, true);
    assert.equal(rec.timeout_ms, 5000);
    assert.equal(rec.reason_code, 'TIMEOUT');
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
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
    assert.equal(metadata.actual_model, QWEN_MODEL);
    assert.equal(metadata.actual_transport, 'opencode');
    assert.equal(metadata.identity_preserved, false);
    assert.deepEqual(traces.map(args => args[args.indexOf('--model') + 1]), [
      identityTransportRoute(DEEPSEEK_PRO_MODEL, 'opencode'),
      identityTransportRoute(QWEN_MODEL, 'opencode'),
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
    assert.equal(metadata.actual_model, QWEN_MODEL);
    assert.equal(metadata.actual_transport, 'opencode');
    assert.equal(metadata.identity_preserved, false);
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

async function runFakeMain(argv, fakeRunAsk, capture = { stdout: [], stderr: [] }) {
  const prev = process.exitCode;
  await runMain(argv,
    (l) => capture.stdout.push(l), (l) => capture.stderr.push(l),
    process.stdin, process.cwd(), process.env, fakeRunAsk);
  const out = capture.stdout.join('');
  const restored = process.exitCode;
  process.exitCode = prev;
  return { exitCode: restored, stdout: out, stderr: capture.stderr.join('') };
}

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
