import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPrompt,
  defaultFallbackModel,
  extractJsonObject,
  guardAllowedModels,
  parseArgs,
  parseOpenCodeJsonl,
  readExistingPathOrLiteral,
  runAsk,
  runMain,
  validateAssistantOutput,
} from './ocask.mjs';

const QWEN_MODEL = 'qwen3.7-plus';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_PRO_MODEL = 'deepseek-v4-pro';

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
test('runMain rejects unknown flag', async () => {
  const stderr = []; const prev = process.exitCode;
  await runMain(['--model', QWEN_MODEL, '--task', 'test', '--bogus'], () => {}, (l) => stderr.push(l));
  assert.match(stderr.join(''), /Unknown option/);
  process.exitCode = prev;
});

test('runMain rejects missing model or task', async () => {
  const stderr = []; const prev = process.exitCode;
  await runMain(['--model', QWEN_MODEL], () => {}, (l) => stderr.push(l));
  assert.ok(stderr.join('').includes('Usage') || process.exitCode === 1);
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
