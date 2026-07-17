#!/usr/bin/env node
// ocask — provider-agnostic review & analysis CLI for paid models.
// Supports DeepSeek API, Qwen/Alibaba API, and OpenCode CLI backends.
// See ARCHITECTURE.md for design rationale.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPaidModelAllowed, PAID_MODELS } from './ocverify.mjs';
import { invokeWithFallback, ProviderError, modelFamily, availableProviders, defaultProvider } from './providers/factory.mjs';

const MAX_PLAUSIBLE_PATH_LENGTH = 4096;

// ── USAGE ──
export const USAGE = 'Usage: ocask --model <id> --task <path|-|string> [--provider opencode|deepseek|qwen] [--system <path|-|string>] [--context <path|-|string>] [--json] [--require-verdict] [--no-fallback] [--lens code-review|architecture|security|tdd|maintainability|deep-modules|general] [--metadata <path>] [--temperature 0] [--max-tokens N] [--timeout-ms N] [--fallback-model <id>]';

const BOOLEAN_ARGS = new Set(['json', 'require-verdict', 'no-fallback']);
const VALUE_ARGS = new Set([
  'model', 'task', 'system', 'context', 'provider', 'lens',
  'metadata', 'temperature', 'max-tokens', 'timeout-ms', 'fallback-model',
]);

// ── HELPERS ──
function makeError(message, code) {
  const err = new Error(message); err.code = code; return err;
}

function parsePositiveInt(value, label, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseTemperature(value) {
  if (value === undefined) return 0;
  const t = Number(value);
  if (!Number.isFinite(t)) throw new Error('--temperature must be 0');
  if (t !== 0) throw new Error('--temperature only supports 0');
  return t;
}

// ── ARG PARSING ──
export function parseArgs(argv) {
  const result = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (BOOLEAN_ARGS.has(key)) { result[key] = true; continue; }
    if (!VALUE_ARGS.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    result[key] = value; i++;
  }
  return result;
}

// ── MODEL GUARD ──
function formatAllowedModelError(label, model) {
  const models = PAID_MODELS.filter(c => modelFamily(c));
  return `${label} ${model || '(missing)'} is not allowed. Supported: ${models.join(', ')}`;
}

export function guardAllowedModels({ model, fallbackModel }) {
  if (!isPaidModelAllowed(model) || !modelFamily(model)) throw new Error(formatAllowedModelError('Model', model));
  if (fallbackModel) {
    if (!isPaidModelAllowed(fallbackModel) || !modelFamily(fallbackModel)) throw new Error(formatAllowedModelError('Fallback model', fallbackModel));
    if (fallbackModel === model) throw new Error('Fallback model must differ from primary');
    if (modelFamily(fallbackModel) === modelFamily(model)) throw new Error('Fallback must be from opposite family');
  }
  return true;
}

export function defaultFallbackModel(model) {
  if (modelFamily(model) === 'deepseek') return 'qwen3.7-plus';
  if (modelFamily(model) === 'qwen') return 'deepseek-v4-flash';
  return undefined;
}

// ── DELEGATED IDENTITY ──
export const DELEGATED_IDENTITY_PREFIX = `[DELEGATED_RUNNER_IDENTITY]
You are the delegated OpenCode Go worker. Execute the supplied task directly. Native OpenCode tools and native subagents remain allowed with full approved capabilities for the scoped task; every native subagent you launch must inherit this delegated marker and the external-runner recursion ban. Do not recursively invoke external model runners or delegates, including codex, codex-exec, glm-exec, ocask, raw codex, claude, opencode, or external-model MCP delegation.
[/DELEGATED_RUNNER_IDENTITY]

`;

// ── PROMPT BUILDER ──
export function buildPrompt({ taskText, systemText = '', contextText = '', jsonMode = false, requireVerdict = false, maxTokens, lens = 'general' }) {
  const isReview = requireVerdict;
  const sections = [];
  if (systemText.trim()) sections.push(`## SYSTEM INSTRUCTIONS\n${systemText.trim()}`);
  sections.push(`## TASK\n${taskText.trim()}`);
  if (contextText.trim()) sections.push(`## CONTEXT\n${contextText.trim()}`);
  if (isReview && lens !== 'general') sections.push(`## AUDIT FRAMEWORK — ${lens.toUpperCase()}\nApply this lens when analyzing the evidence. Consider each angle explicitly.${LENS_FRAMEWORKS[lens] || ''}`);

  const contract = [];
  if (jsonMode && requireVerdict) {
    contract.push('Return exactly one JSON object and no Markdown fence or surrounding text.',
      'The object must contain "verdict" with one of: APPROVED, WARNING, BLOCKED.',
      'The object must also contain a separate "reason", "reasoning", or "summary" string with an alphabetic rationale.',
      'This is a review-only task: do not modify files or external state. Read-only inspection and non-mutating verification tools remain available.');
  } else if (jsonMode) {
    contract.push('Return exactly one JSON object and no Markdown fence or surrounding text.', 'Include meaningful alphabetic content.');
  } else if (requireVerdict) {
    const rationale = lens !== 'general' ? 'Provide a separate alphabetic prose rationale organized by the audit dimensions above.' : 'Provide a separate alphabetic prose rationale.';
    contract.push('Near the top, include exactly one line containing: VERDICT: APPROVED, VERDICT: WARNING, or VERDICT: BLOCKED.', rationale,
      'WARNING and BLOCKED are valid review outcomes; choose the verdict that the evidence supports.',
      'This is a review-only task: do not modify files or external state. Read-only inspection and non-mutating verification tools remain available.');
  } else {
    contract.push('Return a direct answer containing alphabetic prose; do not return only numbers or punctuation.');
  }
  if (maxTokens !== undefined) contract.push(`Advisory response limit: keep the response within approximately ${maxTokens} tokens.`);
  const guidanceKey = isReview ? (lens !== 'general' ? 'review' : 'review-general') : 'default';
  sections.push(`## EXECUTION GUIDANCE\n${EXECUTION_GUIDANCE[guidanceKey]}`);
  sections.push(`## RESPONSE CONTRACT\n${contract.join('\n')}`);
  return sections.join('\n\n');
}

const EXECUTION_GUIDANCE = {
  review: [
    'This is an analytical review. Think step by step — show your reasoning before reaching a verdict.',
    'Inspect evidence deeply: use Read, Glob, and Grep to examine relevant files, trace call paths, and check edge cases.',
    'Cite specific code patterns, function signatures, or line references that support each finding.',
    'Be ambitious about structural simplification: prefer solutions that delete complexity over those that rearrange it. If there is a "code judo" move that makes the implementation dramatically simpler and more elegant, push for it.',
    'Consider the system context: how does this change interact with existing modules, invariants, and contracts?',
    'Focus only on what matters: ignore style trivia unless it signals a deeper design flaw.',
  ].join('\n'),
  'review-general': [
    'This is an analytical review. Think step by step — show your reasoning before reaching a verdict.',
    'Inspect evidence deeply: use Read, Glob, and Grep to examine relevant files, trace call paths, and check edge cases.',
    'Cite specific code patterns, function signatures, or line references that support each finding.',
    'Consider the system context: how does this change interact with existing modules, invariants, and contracts?',
    'Focus only on what matters: ignore style trivia unless it signals a deeper design flaw.',
  ].join('\n'),
  default: ['Answer directly. Inspect only the evidence needed, and avoid unrelated discovery or delegation; use available tools when they materially help.'].join('\n'),
};

const LENS_FRAMEWORKS = {
  'code-review': `
- **Correctness**: Does the logic hold for all inputs including edge cases and error paths?
- **Completeness**: Are all spec requirements addressed? Any missing branches, null checks, or error handling?
- **Consistency**: Does this match the codebase's existing patterns, conventions, and idioms?
- **Simplicity**: Could this be simpler without losing correctness? Any unnecessary abstraction or indirection?
- **Code smells** — scan for Fowler's catalogue:
  - Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest.`,

  'architecture': `
- **Module boundaries**: Does the change respect existing seams or leak responsibilities across modules?
- **Coupling and cohesion**: Does it increase coupling? Is new code cohesive with its neighbors?
- **Deep vs shallow modules** (Ousterhout / Pocock): Deep = small interface + lots of implementation. Shallow = interface nearly as complex as implementation.
  - Apply the *deletion test*: if you deleted this module, would complexity reappear across N callers (earning its keep) or just vanish (pass-through)?
- **Seams** (Feathers): places to alter behaviour without editing. One adapter = hypothetical seam, two = real one. The interface IS the test surface.
- **Change amplification**: Will a future change require cascading edits elsewhere?
- **Locality**: Do change, bugs, and verification concentrate in one place or spread across callers?
- **Invariants and contracts**: Are module contracts explicit and preserved? Any implicit assumptions?`,

  'security': `
- **Injection surfaces**: Any unsanitized input flowing into SQL, shell, HTML, or file paths?
- **Auth and access control**: Are credentials, tokens, or API keys ever logged, persisted in plaintext, or passed in command arguments?
- **Data exposure**: Does any output leak internal state, stack traces, or sensitive fields?
- **Privilege boundaries**: Does this code run with appropriate privilege? Any privilege escalation path?
- **Supply chain**: New dependencies? Unsafe imports? Trust boundaries crossed?`,

  'tdd': `
- **Test-contract alignment**: Does each test map to a concrete requirement? Are any requirements untested?
- **Edge case coverage**: Happy path, null/empty inputs, boundary values, error states, concurrency edge cases.
- **Test independence**: Can tests run in any order? Any shared mutable state between tests?
- **Assertion quality**: Are assertions specific and meaningful, or just presence checks?
- **Red-green-refactor**: Is there evidence that the test was written before the implementation? If the spec changed, was the test updated first?
- **Anti-patterns to flag aggressively**: Implementation-coupled tests, tautological assertions (expected value computed same way as code), horizontal slicing (all tests first, no vertical loops).`,

  'maintainability': `
This is a thermo-nuclear code quality audit. Be ambitious — search for "code judo" moves that make the implementation dramatically simpler, smaller, and more elegant. Do not rubber-stamp working code that leaves the codebase messier.

- **Code judo**: Is there a restructuring that preserves behavior but deletes whole categories of complexity? Prefer solutions that make the code feel inevitable in hindsight.
- **File size boundary (1K lines)**: Did this push a file past 1000 lines without a very strong reason? Prefer extracting helpers, sub-modules, or local abstractions instead of letting files sprawl.
- **Spaghetti growth**: Be highly suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows. Push logic into dedicated abstractions instead.
- **Directness**: Prefer direct, boring, maintainable code over hacky, magical, or clever code. Flag thin wrappers, identity abstractions, or pass-through helpers that add indirection without clarity.
- **Type and boundary cleanliness**: Question unnecessary optionality, \`unknown\`, \`any\`, or cast-heavy code. Prefer explicit typed contracts over loosely-shaped ad-hoc objects.
- **Canonical layer discipline**: Is logic in the right file and package? Call out feature logic leaking into shared paths. Prefer existing canonical utilities over bespoke one-offs.
- **Orchestration complexity**: Is independent work unnecessarily serialized? Can related updates leave state half-applied? Flag avoidable orchestration complexity that makes the implementation more brittle.
- **Approval bar**: No clear structural regression, no obvious missed simplification opportunity, no unjustified file-size explosion, and no clear spaghetti-growth from special-case branching.`,

  'deep-modules': `
Audit modules for *depth* — the amount of behavior behind a small interface. Use the codebase-design vocabulary precisely.

- **Interface audit**: What must a caller know to use each affected module correctly? Count methods, parameters, invariants, ordering constraints, error modes, and config. Is the interface smaller than the implementation?
- **Deletion test**: For each module touched by this change — if you deleted it entirely, would its complexity reappear across N callers (it earns its keep), or would it simply vanish (it was a pass-through)?
- **Seam placement**: Where does each module's interface live? Is the seam at the right granularity? Does it accept dependencies (testable) or create them (hard to test)? Does it return results (testable) or produce side effects (hard to test)?
- **Shallow module detection**: Identify any module where the interface is nearly as complex as the implementation. These are pass-throughs or thin wrappers — can the interface be collapsed?
- **Deepening opportunities**: Can you reduce the number of methods? Can you simplify parameters? Can more complexity be hidden behind the interface? Each simplification produces *leverage* and *locality*.
- **Internal seams**: A deep module can be internally composed of small, mockable parts — they just aren't part of the public interface. Are internal seams testable without leaking into the public contract?
- **Adapter discipline**: One adapter = hypothetical seam. Two adapters = real one. Don't introduce seams without actual variation.`,
};

const VALID_LENSES = ['general'].concat(Object.keys(LENS_FRAMEWORKS));

// ── JSONL PARSING ──
export function parseOpenCodeJsonl(stdout) {
  const textParts = [];
  const seenPartIds = new Set();
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const part = event?.part;
    if (event?.type !== 'text' || part?.type !== 'text' || typeof part.text !== 'string') continue;
    if (part.id !== undefined && part.id !== null) {
      const id = String(part.id);
      if (seenPartIds.has(id)) continue;
      seenPartIds.add(id);
    }
    textParts.push(part.text);
  }
  if (textParts.length === 0) throw makeError('No assistant text found in response', 'MODEL_OUTPUT');
  return textParts.join('\n');
}

// ── OUTPUT VALIDATION ──
function hasLetter(value) { return /\p{L}/u.test(value); }

export function extractJsonObject(raw) {
  if (typeof raw !== 'string') throw makeError('Response is not a string', 'MODEL_OUTPUT');
  const trimmed = raw.trim();
  if (!trimmed) throw makeError('Response is empty', 'MODEL_OUTPUT');
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { throw makeError('Could not parse response as JSON', 'MODEL_OUTPUT'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw makeError('Response JSON is not an object', 'MODEL_OUTPUT');
  return parsed;
}

export function validateAssistantOutput(raw, { jsonMode = false, requireVerdict = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw makeError('Output is empty', 'MODEL_OUTPUT');
  const trimmed = raw.trim();
  if (jsonMode) {
    const object = extractJsonObject(trimmed);
    if (!hasLetter(trimmed)) throw makeError('Output must contain alphabetic content', 'MODEL_OUTPUT');
    if (requireVerdict) {
      if (typeof object.verdict !== 'string' || !/^(APPROVED|WARNING|BLOCKED)$/i.test(object.verdict.trim())) throw makeError('JSON review output must contain verdict APPROVED, WARNING, or BLOCKED', 'MODEL_OUTPUT');
      const rationale = ['reason', 'reasoning', 'summary'].map(k => object[k]).find(v => typeof v === 'string' && hasLetter(v));
      if (!rationale) throw makeError('JSON review must contain an alphabetic rationale', 'MODEL_OUTPUT');
    }
    return object;
  }
  if (!hasLetter(trimmed)) throw makeError('Output must contain alphabetic content', 'MODEL_OUTPUT');
  if (requireVerdict) {
    const nonemptyLines = trimmed.split(/\r?\n/).filter(l => l.trim());
    const candidates = nonemptyLines.map((line, index) => {
      const canonical = line.trim().replace(/^#{1,6}\s+/, '').replace(/^[-+*]\s+/, '').replace(/[\*_`]/g, '').trim();
      const match = /^VERDICT\s*:\s*(APPROVED|WARNING|BLOCKED)\s*[.!]?$/i.exec(canonical);
      return match ? { index, verdict: match[1].toUpperCase() } : null;
    }).filter(Boolean);
    if (candidates.length !== 1) throw makeError('Review must contain exactly one explicit VERDICT line', 'MODEL_OUTPUT');
    if (candidates[0].index >= 5) throw makeError('VERDICT line must appear within first five nonempty lines', 'MODEL_OUTPUT');
    const rationale = nonemptyLines.filter((_, i) => i !== candidates[0].index).join('\n');
    if (!hasLetter(rationale)) throw makeError('Review must include alphabetic prose rationale', 'MODEL_OUTPUT');
  }
  return trimmed;
}

// ── FILE / STDIN INPUT ──
function shouldTryAsPath(source) { return !source.includes('\n') && !source.includes('\r') && Buffer.byteLength(source) <= MAX_PLAUSIBLE_PATH_LENGTH; }

export async function readExistingPathOrLiteral(source, stdin = process.stdin) {
  if (source === '-') {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  if (!shouldTryAsPath(source)) return source;
  try { const stat = await fs.stat(source); if (stat.isFile()) return fs.readFile(source, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENAMETOOLONG') throw error; }
  return source;
}

// ── RETRY / FALLBACK ──
function reasonCodeFor(error) {
  const code = error?.code;
  if (code === 'ENTITLEMENT_UNAVAILABLE') return 'entitlement_unavailable';
  if (code === 'MODEL_OUTPUT') return 'malformed_contract';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'RATE_LIMITED') return 'rate_limited';
  if (code === 'AUTH_FAILURE') return 'auth_failure';
  if (code === 'PROVIDER_ERROR') return 'provider_error';
  if (code === 'CONNECTION_ERROR') return 'connection_error';
  if (code === 'ALL_PROVIDERS_EXHAUSTED') return 'all_exhausted';
  return code || 'unknown';
}

function retryCorrection(error) { return `## RETRY CORRECTION\nThe prior attempt failed with reason code: ${reasonCodeFor(error)}. Follow the response contract exactly. Do not repeat the invalid response.`; }

function isFallbackEligible(error) { return new Set(['MODEL_OUTPUT']).has(error?.code); }

// ── CORE INVOCATION ──
export async function runAsk({
  model, taskText, systemText = '', contextText = '',
  jsonMode = false, requireVerdict = false, noFallback = false,
  lens = 'general', temperature = 0, maxTokens, timeoutMs = 0,
  fallbackModel, provider = null, cwd = process.cwd(), env = process.env,
}) {
  parseTemperature(String(temperature));
  guardAllowedModels({ model, fallbackModel });

  const selectedFallback = noFallback ? null : (fallbackModel || (requireVerdict ? defaultFallbackModel(model) : null));
  if (selectedFallback) guardAllowedModels({ model, fallbackModel: selectedFallback });

  const originalPrompt = buildPrompt({ taskText, systemText, contextText, jsonMode, requireVerdict, maxTokens, lens });
  const options = { jsonMode, requireVerdict };
  const runStarted = Date.now();
  const metadata = { requested_model: model, actual_model: null, no_fallback: Boolean(noFallback), input_bytes: Buffer.byteLength(originalPrompt, 'utf8'), output_bytes: null, attempts: [], exit_code: null, fallback_used: false };

  const timeAttempt = async (askModel, prompt) => {
    const t0 = Date.now();
    try {
      const result = await invokeWithFallback({
        model: askModel, prompt: DELEGATED_IDENTITY_PREFIX + prompt,
        timeoutMs, env, cwd, preferredProvider: provider, noFallback: true, // no provider-level fallback on first attempt
      });
      const raw = result.commandOutput || parseOpenCodeJsonl(result.stdout);
      const out = validateAssistantOutput(raw, options);
      metadata.attempts.push({ model: askModel, duration_ms: Date.now() - t0, outcome: 'success', reason_code: 'ok', fallback: askModel !== model, provider: result.provider });
      metadata.output_bytes = Buffer.byteLength(typeof out === 'string' ? out : JSON.stringify(out), 'utf8');
      return out;
    } catch (error) {
      error.ocaskAttempt = { model: askModel, duration_ms: Date.now() - t0, outcome: 'failed', reason_code: reasonCodeFor(error), fallback: askModel !== model };
      throw error;
    }
  };

  let result;
  try {
    const out = await timeAttempt(model, originalPrompt);
    result = { ok: true, output: out, model }; metadata.actual_model = model;
  } catch (primaryError) {
    metadata.attempts.push(primaryError.ocaskAttempt || { model, duration_ms: Date.now() - runStarted, outcome: 'failed', reason_code: reasonCodeFor(primaryError), fallback: false });
    metadata.actual_model = model;
    if (!selectedFallback || !isFallbackEligible(primaryError)) {
      metadata.exit_code = 1; metadata.duration_ms = Date.now() - runStarted;
      primaryError.ocaskMetadata = metadata; throw primaryError;
    }
    try {
      const fbOut = await timeAttempt(selectedFallback, `${originalPrompt}\n\n${retryCorrection(primaryError)}`);
      result = { ok: true, output: fbOut, model: selectedFallback }; metadata.actual_model = selectedFallback; metadata.fallback_used = true;
    } catch (fbError) {
      metadata.attempts.push(fbError.ocaskAttempt || { model: selectedFallback, duration_ms: 0, outcome: 'failed', reason_code: reasonCodeFor(fbError), fallback: true });
      metadata.actual_model = selectedFallback; metadata.exit_code = 1; metadata.duration_ms = Date.now() - runStarted;
      fbError.ocaskMetadata = metadata; throw fbError;
    }
  }
  metadata.exit_code = 0; metadata.duration_ms = Date.now() - runStarted;
  return { ...result, metadata };
}

// ── ATOMIC METADATA WRITE ──
async function writeAtomicPrivate(target, text) {
  const parsed = path.resolve(target);
  const dir = path.dirname(parsed);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(parsed)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await fs.open(tmp, 'wx', 0o600);
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, parsed);
  await fs.chmod(parsed, 0o600);
}

// ── MAIN ENTRY POINT ──
export async function runMain(
  argv = process.argv.slice(2),
  writeStdout = console.log,
  writeStderr = console.error,
  stdin = process.stdin,
  cwd = process.cwd(),
  env = process.env,
  providedRunAsk = null,  // override for testing
) {
  let args = null;
  try {
    args = parseArgs(argv);
    if (!args.model || !args.task) throw new Error(USAGE);

    const stdinSources = ['task', 'system', 'context'].filter(k => args[k] === '-');
    if (stdinSources.length > 1) throw new Error('Only one of --task, --system, --context may read from stdin');

    const temperature = parseTemperature(args.temperature);
    const maxTokens = parsePositiveInt(args['max-tokens'], '--max-tokens', undefined);
    const timeoutMs = parsePositiveInt(args['timeout-ms'], '--timeout-ms', 0);
    const noFallback = args['no-fallback'] === true;
    if (noFallback && args['fallback-model']) throw new Error('--no-fallback cannot be combined with --fallback-model');
    if (noFallback && args['provider'] && args['provider'] !== defaultProvider(args.model)) throw new Error('--no-fallback cannot be combined with a non-default --provider');

    guardAllowedModels({ model: args.model, fallbackModel: args['fallback-model'] });

    const rawLens = args.lens || 'general';
    const lens = VALID_LENSES.includes(rawLens) ? rawLens : (() => { throw new Error(`--lens must be one of: ${VALID_LENSES.join(', ')}`); })();
    if (lens !== 'general' && args['require-verdict'] !== true) throw new Error('--lens requires --require-verdict');

    const provider = args.provider || null;
    if (provider && !availableProviders().includes(provider)) throw new Error(`--provider must be one of: ${availableProviders().join(', ')}`);

    const [taskText, systemText, contextText] = await Promise.all([
      readExistingPathOrLiteral(args.task, stdin),
      args.system ? readExistingPathOrLiteral(args.system, stdin) : Promise.resolve(''),
      args.context ? readExistingPathOrLiteral(args.context, stdin) : Promise.resolve(''),
    ]);

    const result = await runAsk({
      model: args.model, taskText, systemText, contextText,
      jsonMode: args.json === true, requireVerdict: args['require-verdict'] === true,
      noFallback, lens, provider, temperature, maxTokens, timeoutMs,
      fallbackModel: args['fallback-model'], cwd, env,
    });

    if (args.metadata) await writeAtomicPrivate(args.metadata, JSON.stringify(result.metadata || {}) + '\n');
    writeStdout(args.json ? JSON.stringify(result.output) : result.output);
  } catch (error) {
    const cause = error?.message || 'delegation failed';
    writeStderr(`ocask error: ${cause}`);
    if (argv.includes('--json')) writeStdout(JSON.stringify({ error: cause }));
    if (args?.metadata && error?.ocaskMetadata) {
      await writeAtomicPrivate(args.metadata, JSON.stringify(error.ocaskMetadata) + '\n').catch(() => {});
    }
    process.exitCode = 1;
  }
}

async function main() { await runMain(); }
if (import.meta.url === `file://${process.argv[1]}`) { main(); }
