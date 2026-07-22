#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PAID_MODELS = [
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'hy3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'minimax-m3',
  'minimax-m2.7',
  'mimo-v2.5-pro',
  'mimo-v2.5'
];

// Measured 2026-07-23: Zen POST /chat/completions returned HTTP 400
// model_not_supported for hy3-preview. hy3 is served only by `ocask --model hy3`
// through the OpenCode CLI, so it must never reach this HTTP client.
export const ZEN_SERVABLE_MODELS = PAID_MODELS.filter(model => model !== 'hy3');

const BASE_URL = 'https://opencode.ai/zen/go/v1';
const CHAT_URL = `${BASE_URL}/chat/completions`;
const MODELS_URL = `${BASE_URL}/models`;
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_TOOL_ROUNDS = 14;

const SYSTEM_PROMPT = `You are a strict read-only verification model.
Do not execute destructive operations.
Do not include chain-of-thought.
Return only the requested JSON object.
Make a two-tier verdict with:
- "verdict" as confirm or reject.
- "hard" as null or a concrete hard blocker.
- "soft_flags" as structured low-confidence observations.
- "evidence" as short strings supporting the verdict.`;

const VERDICT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a literal pattern in a repo file or folder.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' }
        },
        required: ['pattern'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file or a line range from a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start: { type: 'number' },
          end: { type: 'number' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_show',
      description: 'Show commit or path contents via git show.',
      parameters: {
        type: 'object',
        properties: {
          ref_or_path: { type: 'string' }
        },
        required: ['ref_or_path'],
        additionalProperties: false
      }
    }
  }
];

function normalizePath(p) {
  if (!p) return '';
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export function isPaidModelAllowed(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  if (/-free$/i.test(modelId)) return false;
  return PAID_MODELS.includes(modelId);
}

function isZenServableModel(modelId) {
  return ZEN_SERVABLE_MODELS.includes(modelId);
}

function zenModelError(label, modelId) {
  return `${label} ${modelId} is not served by the Zen HTTP verifier. Use ocask --model ${modelId} instead; ocask routes it through the OpenCode CLI.`;
}

export function buildVerifierPrompt({ lens, diff, spec, acceptance, context }) {
  const safeDiff = diff?.trim() ? diff : '(no diff provided)';
  const safeSpec = spec?.trim() ? spec : '(no spec provided)';
  const safeAcceptance = acceptance?.trim() ? acceptance : '(no acceptance criteria provided)';
  const safeContext = context?.trim() ? context : '(no context provided)';
  return [
    `Lens: ${lens || 'general'}`,
    `Spec/intent:\n${safeSpec}`,
    `Acceptance criteria:\n${safeAcceptance}`,
    `Diff:\n${safeDiff}`,
    `Context:\n${safeContext}`,
    'Mandatory deep probing:',
    '- The context evidence bundle contains the changed files and local dependencies real source when available; treat that evidence as real repo code.',
    '- Ground every judgment in the real code present in the evidence bundle, not in assumptions from the diff alone.',
    '- Read the real implementation of changed, called, and calling symbols that are present in the evidence.',
    '- Trace actual imports, exports, callers, callees, and data flow using the code present in the evidence.',
    '- Every soft_flag, hard_repro, and evidence entry must cite exact file:line evidence from real code you read.',
    '- If tools are available, you may use them to inspect missing load-bearing code.',
    '- If a load-bearing implementation is absent from the evidence and no tools are available, set verdict to "error" and state the missing file or symbol instead of guessing.',
    'Use the diff + spec + acceptance + lens to return JSON only using this schema:',
    '{',
    '  "verdict": "confirm|reject|error",',
    '  "hard": null or {"repro": {"kind": "test|command|assertion", "body": string, "expected": string},',
    '  "soft_flags": [{"file": string, "line": number, "category": string, "claim": string, "confidence": number}],',
    '  "evidence": [string],',
    '  "error": string optional',
    '}',
    'Decision rule: first tier is hard blockers ("hard"), second tier are soft risks in soft_flags.'
  ].join('\n');
}

export function parseVerdictText(raw) {
  if (typeof raw !== 'string') {
    const err = new Error('Verifier output is not a string');
    err.code = 'VERDICT_PARSE';
    throw err;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    const err = new Error('Verifier output is empty');
    err.code = 'VERDICT_PARSE';
    throw err;
  }

  const attempts = [
    trimmed,
    trimmed.replace(/^```json\n?|```$/g, '').trim(),
    (() => {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      return start >= 0 && end > start ? trimmed.slice(start, end + 1) : '';
    })()
  ];

  for (const chunk of attempts) {
    if (!chunk) continue;
    try {
      return JSON.parse(chunk);
    } catch {
      continue;
    }
  }

  const err = new Error('Could not parse verifier output as JSON');
  err.code = 'VERDICT_PARSE';
  throw err;
}

function isKindOk(kind) {
  return kind === 'test' || kind === 'command' || kind === 'assertion';
}

export function validateVerdictShape(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload must be an object');
  } else {
    if (!['confirm', 'reject', 'error'].includes(payload.verdict)) {
      errors.push('verdict must be confirm, reject, or error');
    }

    if (payload.hard !== null) {
      if (!payload.hard || typeof payload.hard !== 'object' || Array.isArray(payload.hard)) {
        errors.push('hard must be null or an object');
      } else {
        const repro = payload.hard.repro;
        if (!repro || typeof repro !== 'object' || Array.isArray(repro)) {
          errors.push('hard.repro must be an object');
        } else {
          if (typeof repro.body !== 'string') errors.push('hard.repro.body must be a string');
          if (typeof repro.expected !== 'string') errors.push('hard.repro.expected must be a string');
          if (!isKindOk(repro.kind)) errors.push('hard.repro.kind must be test, command, or assertion');
        }
      }
    }

    if (!Array.isArray(payload.soft_flags)) {
      errors.push('soft_flags must be an array');
    } else {
      for (const flag of payload.soft_flags) {
        if (!flag || typeof flag !== 'object' || Array.isArray(flag)) {
          errors.push('soft flag must be an object');
          continue;
        }
        if (typeof flag.file !== 'string') errors.push('soft_flag.file must be a string');
        if (typeof flag.line !== 'number' || !Number.isFinite(flag.line)) {
          errors.push('soft_flag.line must be a number');
        }
        if (typeof flag.category !== 'string') errors.push('soft_flag.category must be a string');
        if (typeof flag.claim !== 'string') errors.push('soft_flag.claim must be a string');
        if (typeof flag.confidence !== 'number' || flag.confidence < 0 || flag.confidence > 1) {
          errors.push('soft_flag.confidence must be number between 0 and 1');
        }
      }
    }

    if (!Array.isArray(payload.evidence)) {
      errors.push('evidence must be an array');
    } else if (payload.evidence.some((entry) => typeof entry !== 'string')) {
      errors.push('evidence entries must be strings');
    }
  }

  if (errors.length > 0) {
    const err = new Error(errors.join('; '));
    err.code = 'VERDICT_VALIDATE';
    throw err;
  }

  return {
    model: payload.model || '',
    lens: payload.lens || '',
    verdict: payload.verdict,
    hard: payload.hard ?? null,
    soft_flags: payload.soft_flags,
    evidence: payload.evidence,
    usage: payload.usage ?? null,
    error: payload.error
  };
}

export function errorVerdict(message, overrides = {}) {
  return {
    model: overrides.model || '',
    lens: overrides.lens || '',
    verdict: 'error',
    hard: null,
    soft_flags: [],
    evidence: [],
    usage: null,
    error: message || 'verification failed'
  };
}

export function isPathInsideRepo(repoRoot, candidatePath) {
  const base = path.resolve(repoRoot);
  const resolved = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(base, candidatePath);
  if (resolved === base) return true;
  const rel = path.relative(base, resolved);
  return !!rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

export async function dispatchToolCall(toolCall, repoRoot) {
  const args = (() => {
    try {
      const raw = typeof toolCall.function?.arguments === 'string'
        ? toolCall.function.arguments
        : '{}';
      return JSON.parse(raw);
    } catch {
      return { __invalid: true };
    }
  })();

  if (args.__invalid) {
    return JSON.stringify({ error: 'tool arguments are not valid JSON' });
  }

  const safeRepo = path.resolve(repoRoot);
  const name = toolCall.function?.name;

  if (name === 'grep') {
    const pattern = args.pattern;
    const targetPath = args.path || '.';
    if (typeof pattern !== 'string' || typeof targetPath !== 'string') {
      return JSON.stringify({ error: 'grep requires a pattern and optional path' });
    }
    if (!isPathInsideRepo(safeRepo, targetPath)) {
      return JSON.stringify({ error: 'path escapes repo' });
    }

    const fullPath = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(safeRepo, targetPath);

    try {
      const { stdout } = await execFileAsync('grep', ['-R', '-n', '--', pattern, fullPath]);
      return JSON.stringify({ exitCode: 0, output: stdout.trim() });
    } catch (error) {
      return JSON.stringify({ exitCode: 1, output: error.stdout || error.message });
    }
  }

  if (name === 'read_file') {
    const filePath = args.path;
    const start = args.start;
    const end = args.end;

    if (typeof filePath !== 'string') {
      return JSON.stringify({ error: 'read_file requires path' });
    }
    if (!isPathInsideRepo(safeRepo, filePath)) {
      return JSON.stringify({ error: 'path escapes repo' });
    }

    const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(safeRepo, filePath);

    try {
      if (start === undefined && end === undefined) {
        const { stdout } = await execFileAsync('cat', [fullPath]);
        return JSON.stringify({ exitCode: 0, output: stdout });
      }

      const startLine = Math.max(1, Math.trunc(Number(start)));
      const endLine = end === undefined ? startLine : Math.max(startLine, Math.trunc(Number(end)));
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
        return JSON.stringify({ error: 'start/end must be numbers' });
      }

      const { stdout } = await execFileAsync('sed', ['-n', `${startLine},${endLine}p`, fullPath]);
      return JSON.stringify({ exitCode: 0, output: stdout });
    } catch (error) {
      return JSON.stringify({ exitCode: 1, output: error.stdout || error.message });
    }
  }

  if (name === 'git_show') {
    const refOrPath = args.ref_or_path;
    if (typeof refOrPath !== 'string') {
      return JSON.stringify({ error: 'git_show requires ref_or_path' });
    }
    if (refOrPath.startsWith('-')) {
      return JSON.stringify({ error: 'git_show ref_or_path must not start with -' });
    }

    const colonIndex = refOrPath.indexOf(':');
    if (colonIndex > 0) {
      const gitPath = refOrPath.slice(colonIndex + 1);
      if (!isPathInsideRepo(safeRepo, gitPath)) {
        return JSON.stringify({ error: 'path escapes repo' });
      }
    }

    try {
      const { stdout } = await execFileAsync('git', ['show', refOrPath], { cwd: safeRepo });
      return JSON.stringify({ exitCode: 0, output: stdout });
    } catch (error) {
      return JSON.stringify({ exitCode: 1, output: error.stdout || error.message });
    }
  }

  return JSON.stringify({ error: `unknown tool: ${name}` });
}

function isRetryableError(error) {
  return error && (error.code === 'NETWORK' || error.code === 'TIMEOUT' || error.code === 'HTTP');
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'TIMEOUT';
      throw timeoutError;
    }
    const wrapped = new Error(error.message || 'Network error');
    wrapped.code = 'NETWORK';
    throw wrapped;
  }
}

async function callModel({
  model,
  messages,
  maxTokens,
  timeoutMs,
  fetchImpl,
  apiKey,
  useTools
}) {
  const body = {
    model,
    messages,
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: maxTokens
  };
  if (useTools) {
    body.tools = VERDICT_TOOLS;
    body.tool_choice = 'auto';
  }

  const response = await fetchWithTimeout(
    fetchImpl,
    CHAT_URL,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    },
    timeoutMs
  );

  const text = await response.text();

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${text}`);
    error.code = 'HTTP';
    error.status = response.status;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    error.code = error.code || 'HTTP_PARSE';
    throw error;
  }

  return payload;
}

async function completeWithTools({
  model,
  messages,
  repo,
  maxToolRounds,
  timeoutMs,
  maxTokens,
  fetchImpl,
  apiKey,
  useTools
}) {
  let current = [...messages];
  let rounds = 0;

  while (true) {
    const payload = await callModel({
      model,
      messages: current,
      maxTokens,
      timeoutMs,
      fetchImpl,
      apiKey,
      useTools
    });

    const choice = payload?.choices?.[0];
    if (!choice || !choice.message) {
      const invalid = new Error('Malformed model response');
      invalid.code = 'VERDICT_PARSE';
      throw invalid;
    }

    const message = choice.message;
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (toolCalls.length === 0 || rounds >= maxToolRounds) {
      return {
        message,
        usage: payload.usage || null
      };
    }

    rounds += 1;
    current.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: toolCalls
    });

    for (const call of toolCalls) {
      const toolResult = await dispatchToolCall(call, repo);
      current.push({
        role: 'function',
        tool_call_id: call.id,
        name: call.function?.name,
        content: toolResult
      });
    }
  }
}

export async function runVerifier({
  model,
  lens,
  diff,
  spec,
  acceptance = '',
  repo = process.cwd(),
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fallbackModel,
  maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
  fetchImpl = fetch,
  apiKey,
  tools = false,
  context = ''
}) {
  if (!isPaidModelAllowed(model)) {
    throw new Error(`Model ${model} is not allowed. Use a paid model from the allowlist and do not use free tiers.`);
  }
  if (fallbackModel && fallbackModel !== model && !isPaidModelAllowed(fallbackModel)) {
    throw new Error(`Fallback model ${fallbackModel} is not allowed. Use a paid model from the allowlist and do not use free tiers.`);
  }
  if (!isZenServableModel(model)) throw new Error(zenModelError('Model', model));
  if (fallbackModel && fallbackModel !== model && !isZenServableModel(fallbackModel)) {
    throw new Error(zenModelError('Fallback model', fallbackModel));
  }

  const prompt = buildVerifierPrompt({
    lens,
    diff,
    spec,
    acceptance,
    context
  });

  const initialMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt }
  ];

  const models = [model];
  if (fallbackModel && fallbackModel !== model) models.push(fallbackModel);

  let lastError = null;

  for (const currentModel of models) {
    for (let transportAttempt = 0; transportAttempt < 2; transportAttempt += 1) {
      try {
        let parseAttempt = 0;
        while (parseAttempt < 2) {
          const result = await completeWithTools({
            model: currentModel,
            messages: initialMessages,
            repo,
            maxToolRounds,
            timeoutMs,
            maxTokens,
            fetchImpl,
            apiKey,
            useTools: tools
          });

          try {
            const parsed = parseVerdictText(result.message.content || '');
            const normalized = validateVerdictShape(parsed);
            return {
              model: currentModel,
              lens,
              verdict: normalized.verdict,
              hard: normalized.hard,
              soft_flags: normalized.soft_flags,
              evidence: normalized.evidence,
              usage: result.usage,
              error: normalized.error
            };
          } catch (error) {
            if (error.code === 'VERDICT_PARSE' && parseAttempt < 1) {
              parseAttempt += 1;
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        if (error.code === 'VERDICT_PARSE' || error.code === 'VERDICT_VALIDATE') {
          return errorVerdict(error.message, { model: currentModel, lens });
        }

        lastError = error;
        if (!isRetryableError(error) || transportAttempt === 1) {
          break;
        }
      }
    }

    if (!isRetryableError(lastError)) break;
  }

  return errorVerdict((lastError && lastError.message) || 'verification failed', { model, lens });
}

async function readTextSource(source) {
  if (!source || source === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }

  return fs.readFile(source, 'utf8');
}

async function readApiKey() {
  const keyPath = normalizePath(process.env.OPENCODE_GO_KEY_FILE || path.join(os.homedir(), '.opencode-go-key'));
  let key = null;
  try {
    key = await fs.readFile(keyPath, 'utf8');
  } catch {
    return null;
  }
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function listModels(fetchImpl, apiKey) {
  const response = await fetchWithTimeout(
    fetchImpl,
    MODELS_URL,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` }
    },
    DEFAULT_TIMEOUT_MS
  );
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${text}`);
    error.code = 'HTTP';
    throw error;
  }
  const payload = JSON.parse(text);
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.map((entry) => entry.id);
}

function parseArgs(argv) {
  const boolArgs = new Set(['probe', 'selftest', 'tools']);
  const result = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    if (boolArgs.has(key)) {
      result[key] = true;
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    result[key] = value;
    i += 1;
  }

  return result;
}

export async function runProbe(args, fetchImpl = fetch) {
  if (!isPaidModelAllowed(args.model)) {
    console.error(`Model ${args.model} is not allowed. Use a paid model from the allowlist and do not use free tiers.`);
    process.exitCode = 1;
    return;
  }
  if (!isZenServableModel(args.model)) {
    console.error(zenModelError('Model', args.model));
    process.exitCode = 1;
    return;
  }

  const apiKey = await readApiKey();
  if (!apiKey) {
    console.error('Missing OPENCODE_GO_KEY_FILE key. Set OPENCODE_GO_KEY_FILE to a readable key file.');
    process.exitCode = 1;
    return;
  }

  const models = await listModels(fetchImpl, apiKey);
  const hasModel = models.includes(args.model);
  console.log(`Models: ${models.join(', ') || '(none)'}`);
  console.log(`Model ${args.model} present: ${hasModel ? 'yes' : 'no'}`);

  const message = {
    role: 'user',
    content: 'Call one tool and return the tool output. Then answer with {"verdict":"confirm","hard":null,"soft_flags":[],"evidence":["tool ok"]}.'
  };
  try {
    const payload = await callModel({
      model: args.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        message
      ],
      useTools: true,
      maxTokens: 120,
      timeoutMs: asNumber(args['timeout-ms'], DEFAULT_TIMEOUT_MS),
      fetchImpl,
      apiKey
    });
    const calls = payload?.choices?.[0]?.message?.tool_calls;
    console.log(`tool-calling: ${Array.isArray(calls) && calls.length > 0 ? 'PASS' : 'FAIL'}`);
  } catch (error) {
    console.log(`tool-calling: FAIL (${error.message})`);
  }
}

async function runSelfTest() {
  await execFileAsync(process.execPath, [path.join(process.cwd(), 'test.mjs')], {
    stdio: 'inherit'
  });
}

export async function runMain(argv = process.argv.slice(2), fetchImpl = fetch, writeStdout = console.log, writeStderr = console.error) {
  const args = parseArgs(argv);

  if (args.selftest) {
    await runSelfTest();
    return;
  }

  if (args.probe) {
    await runProbe(args, fetch);
    return;
  }

  if (!args.model || !args.lens || !args.diff || !args.spec) {
    writeStderr('Usage: node ocverify.mjs --model <id> --lens <lens> --diff <path|-> --spec <path|-> [--repo <dir>] [--context <path|->] [--acceptance <path|->] [--tools] [--max-tokens N] [--timeout-ms N] [--fallback-model <id>] [--max-tool-rounds N]');
    writeStdout(JSON.stringify(errorVerdict('missing required arguments', { model: args.model, lens: args.lens })));
    process.exitCode = 1;
    return;
  }

  if (!isPaidModelAllowed(args.model)) {
    writeStdout(JSON.stringify(errorVerdict(`Model ${args.model} is not allowed. Use a paid model from the allowlist and do not use free tiers.`, { model: args.model, lens: args.lens })));
    process.exitCode = 1;
    return;
  }

  if (!isZenServableModel(args.model)) {
    writeStdout(JSON.stringify(errorVerdict(zenModelError('Model', args.model), { model: args.model, lens: args.lens })));
    process.exitCode = 1;
    return;
  }

  if (args['fallback-model'] && !isPaidModelAllowed(args['fallback-model'])) {
    writeStdout(JSON.stringify(errorVerdict(`Fallback model ${args['fallback-model']} is not allowed. Use a paid model from the allowlist and do not use free tiers.`, { model: args.model, lens: args.lens })));
    process.exitCode = 1;
    return;
  }
  if (args['fallback-model'] && !isZenServableModel(args['fallback-model'])) {
    writeStdout(JSON.stringify(errorVerdict(zenModelError('Fallback model', args['fallback-model']), { model: args.model, lens: args.lens })));
    process.exitCode = 1;
    return;
  }

  const apiKey = await readApiKey();
  if (!apiKey) {
    writeStdout(JSON.stringify(errorVerdict('Missing OPENCODE_GO_KEY_FILE key. Set OPENCODE_GO_KEY_FILE to a readable key file.', { model: args.model, lens: args.lens })));
    process.exitCode = 1;
    return;
  }

  const [diff, spec, acceptance] = await Promise.all([
    readTextSource(args.diff),
    readTextSource(args.spec),
    args.acceptance ? readTextSource(args.acceptance) : Promise.resolve('')
  ]);
  const context = args.context ? await readTextSource(args.context) : '';

  const result = await runVerifier({
    model: args.model,
    lens: args.lens,
    diff,
    spec,
    acceptance,
    repo: args.repo || process.cwd(),
    maxTokens: asNumber(args['max-tokens'], DEFAULT_MAX_TOKENS),
    timeoutMs: asNumber(args['timeout-ms'], DEFAULT_TIMEOUT_MS),
    fallbackModel: args['fallback-model'],
    maxToolRounds: asNumber(args['max-tool-rounds'], DEFAULT_MAX_TOOL_ROUNDS),
    tools: args.tools === true,
    context,
    fetchImpl,
    apiKey
  });

  writeStdout(JSON.stringify(result));
  if (result.verdict === 'error') process.exitCode = 1;
}

async function main() {
  try {
    await runMain(process.argv.slice(2), fetch, console.log, console.error);
  } catch (error) {
    console.log(JSON.stringify(errorVerdict(error.message)));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
