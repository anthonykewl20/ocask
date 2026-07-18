#!/usr/bin/env node
// ocask — provider-agnostic review & analysis CLI for paid models.
// Supports DeepSeek API, Qwen/Alibaba API, and OpenCode CLI backends.
// See ARCHITECTURE.md for design rationale.

import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPaidModelAllowed, PAID_MODELS } from './ocverify.mjs';
import { invokeWithFallback, ProviderError, modelFamily, availableProviders, defaultProvider } from './providers/factory.mjs';
import { logEvent, makeRunId, startRun, logRunStart, logAttemptStart, logAttemptResult,
  logFallback, logVerdict, logError, currentRunId, readLog, doctorReport, diagnoseRun,
  classifyFailure, unwrapOrigin } from './logging.mjs';
import { getPricing, calculateCost, formatCost, formatPricingTable, cumulativeCost, formatCumulativeCost } from './pricing.mjs';
import { notifyUpgrade, CURRENT_VERSION } from './version.mjs';

const MAX_PLAUSIBLE_PATH_LENGTH = 4096;

// ── USAGE ──
export const USAGE = 'Usage: ocask --model <id> --task <path|-|string> [--provider opencode|deepseek|qwen] [--system <path|-|string>] [--context <path|-|string>] [--json] [--require-verdict] [--no-fallback] [--cross-verify] [--lens code-review|architecture|security|tdd|maintainability|deep-modules|general] [--metadata <path>] [--temperature 0] [--max-tokens N] [--timeout-ms N] [--fallback-model <id>]';

const BOOLEAN_ARGS = new Set(['json', 'require-verdict', 'no-fallback', 'cross-verify']);
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

// Deterministic one-way digest of the prompt text (#9). Two runs of the IDENTICAL
// prompt yield the SAME hash so failures can be correlated by task — the old
// randomBytes() value carried no information (identical prompts hashed differently).
// SHA-256 hex truncated to a stable 16-char prefix keeps log lines compact, and the
// output is purely a digest: it never contains prompt text.
export function promptHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
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
    'Base your analysis on the provided evidence. Only inspect additional files if the task explicitly references them.',
    'Focus on what matters: ignore style trivia unless it signals a deeper design flaw.',
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

// ── VERDICT EXTRACTION ──
// Pull an APPROVED/WARNING/BLOCKED verdict out of model output. Handles BOTH the
// prose `VERDICT: <X>` line (text mode) and a JSON object's `.verdict` field
// (jsonMode), so a verdict reached via either response contract is first-class.
// Returns null when no verdict is present (e.g. freeform analysis).
export function extractVerdict(output) {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const v = typeof output.verdict === 'string' ? output.verdict.trim() : '';
    return /^(APPROVED|WARNING|BLOCKED)$/i.test(v) ? v.toUpperCase() : null;
  }
  const text = typeof output === 'string' ? output : '';
  return (text.match(/VERDICT\s*:\s*(APPROVED|WARNING|BLOCKED)/i) || [])[1]?.toUpperCase() || null;
}

// Attach the four-way contract fields to a runAsk success envelope. The verdict is
// derived from the ACTUAL output being returned so it can never drift from what the
// caller observes; the classification is the judgment taxonomy for that verdict.
function withContract(envelope) {
  const verdict = extractVerdict(envelope.output);
  return { ...envelope, verdict, classification: verdict ? classifyFailure(null, { verdict }) : null };
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
// Reports the TRUE mechanism: unwrap the factory's ALL_PROVIDERS_EXHAUSTED wrapper
// and read the originating cause's code. `all_exhausted` is retired as an output —
// the wrapper is structural (noFallback chains are length 1), never the real cause.
function reasonCodeFor(error) {
  return classifyFailure(error).mechanism || 'unknown';
}

function retryCorrection(error) { return `## RETRY CORRECTION\nThe prior attempt failed with reason code: ${reasonCodeFor(error)}. Follow the response contract exactly. Do not repeat the invalid response.`; }

function isFallbackEligible(error) { return new Set(['MODEL_OUTPUT']).has(error?.code); }

// ── CORE INVOCATION ──
export async function runAsk({
  model, taskText, systemText = '', contextText = '',
  jsonMode = false, requireVerdict = false, noFallback = false,
  crossVerify = false,
  lens = 'general', temperature = 0, maxTokens, timeoutMs = 0,
  fallbackModel, provider = null, cwd = process.cwd(), env = process.env,
}) {
  const runId = makeRunId();
  startRun(runId);
  parseTemperature(String(temperature));
  guardAllowedModels({ model, fallbackModel });

  const selectedFallback = noFallback ? null : (fallbackModel || (requireVerdict ? defaultFallbackModel(model) : null));
  if (selectedFallback) guardAllowedModels({ model, fallbackModel: selectedFallback });

  const originalPrompt = buildPrompt({ taskText, systemText, contextText, jsonMode, requireVerdict, maxTokens, lens });
  const options = { jsonMode, requireVerdict };
  const runStarted = Date.now();
  const metadata = { requested_model: model, actual_model: null, no_fallback: Boolean(noFallback), input_bytes: Buffer.byteLength(originalPrompt, 'utf8'), output_bytes: null, attempts: [], exit_code: null, fallback_used: false };

  await logRunStart({
    model, lens, provider, promptHash: promptHash(originalPrompt),
    inputBytes: metadata.input_bytes, timeoutMs,
  });

  let attemptIndex = 0;
  const timeAttempt = async (askModel, prompt, isFallback = false) => {
    const attemptIdx = attemptIndex++;
    const t0 = Date.now();
    try {
      if (isFallback) {
        await logFallback({ fromModel: model, toModel: askModel, fromProvider: provider || defaultProvider(model), toProvider: provider || defaultProvider(askModel), reason: 'malformed_output' });
      }
      const result = await invokeWithFallback({
        model: askModel, prompt: DELEGATED_IDENTITY_PREFIX + prompt,
        timeoutMs, env, cwd, preferredProvider: provider, noFallback: true,
      });
      const raw = result.commandOutput || parseOpenCodeJsonl(result.stdout);
      const out = validateAssistantOutput(raw, options);
      const outBytes = Buffer.byteLength(typeof out === 'string' ? out : JSON.stringify(out), 'utf8');
      const localVerdict = extractVerdict(out);
      // A judgment exists only when this attempt demonstrably produced a verdict.
      const successClass = localVerdict
        ? classifyFailure(null, { verdict: localVerdict })
        : { class: 'no-judgment', subclass: null, locus: null, mechanism: null, censored: false, http_status: null, retry_after: null };
      metadata.attempts.push({ model: askModel, duration_ms: Date.now() - t0, outcome: 'success', reason_code: 'ok', fallback: isFallback, provider: result.provider, class: successClass.class });
      metadata.output_bytes = outBytes;
      await logAttemptResult({
        provider: result.provider || 'unknown', model: askModel, attemptIndex: attemptIdx,
        outcome: 'success', durationMs: Date.now() - t0, timeoutMs, reasonCode: 'ok',
        outputBytes: outBytes, tokensUsed: result.tokensUsed || null,
        classification: successClass,
      });
      return out;
    } catch (error) {
      // Classify from the TRUE (unwrapped) mechanism; attribute the real provider
      // that failed via the originating cause — never the wrapper, never 'unknown'
      // when the cause carries a provider.
      const classification = classifyFailure(error, { timeoutMs });
      const code = classification.mechanism || 'unknown';
      const failProvider = unwrapOrigin(error)?.provider || provider || defaultProvider(askModel) || 'unknown';
      metadata.attempts.push({ model: askModel, duration_ms: Date.now() - t0, outcome: 'failed', reason_code: code, fallback: isFallback, provider: failProvider, class: classification.class, subclass: classification.subclass, locus: classification.locus, mechanism: code });
      await logAttemptResult({
        provider: failProvider, model: askModel, attemptIndex: attemptIdx,
        outcome: 'failed', durationMs: Date.now() - t0, timeoutMs, reasonCode: code,
        outputBytes: 0, tokensUsed: null, errorClass: error?.constructor?.name,
        classification,
      });
      throw error;
    }
  };

  let result;
  try {
    const out = await timeAttempt(model, originalPrompt, false);
    result = { ok: true, output: out, model }; metadata.actual_model = model;
  } catch (primaryError) {
    metadata.actual_model = model;
    if (!selectedFallback || !isFallbackEligible(primaryError)) {
      metadata.exit_code = 1; metadata.duration_ms = Date.now() - runStarted;
      const primaryClass = classifyFailure(primaryError, { timeoutMs });
      const primaryProvider = unwrapOrigin(primaryError)?.provider || provider || defaultProvider(model) || 'unknown';
      await logError({ model, provider: primaryProvider, errorCode: primaryClass.mechanism || 'unknown', errorClass: primaryError?.constructor?.name, attemptCount: attemptIndex, durationMs: metadata.duration_ms, timeoutMs, classification: primaryClass });
      primaryError.ocaskMetadata = metadata; throw primaryError;
    }
    try {
      const fbOut = await timeAttempt(selectedFallback, `${originalPrompt}\n\n${retryCorrection(primaryError)}`, true);
      result = { ok: true, output: fbOut, model: selectedFallback }; metadata.actual_model = selectedFallback; metadata.fallback_used = true;
    } catch (fbError) {
      metadata.actual_model = selectedFallback; metadata.exit_code = 1; metadata.duration_ms = Date.now() - runStarted;
      const fbClass = classifyFailure(fbError, { timeoutMs });
      const fbProvider = unwrapOrigin(fbError)?.provider || provider || defaultProvider(selectedFallback) || 'unknown';
      await logError({ model: selectedFallback, provider: fbProvider, errorCode: fbClass.mechanism || 'unknown', errorClass: fbError?.constructor?.name, attemptCount: attemptIndex, durationMs: metadata.duration_ms, timeoutMs, classification: fbClass });
      fbError.ocaskMetadata = metadata; throw fbError;
    }
  }
  metadata.exit_code = 0; metadata.duration_ms = Date.now() - runStarted;

  // Extract primary verdict (object-aware: works for jsonMode `.verdict` too)
  const primaryOutput = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  const primaryVerdict = extractVerdict(result.output);
  if (primaryVerdict) {
    await logVerdict({ verdict: primaryVerdict, model: result.model, provider, lens, durationMs: metadata.duration_ms, briefRationale: primaryOutput.slice(0, 200) });
  }

  // ── Cross-verify: DeepSeek + Qwen buddy check ──
  if (crossVerify && requireVerdict && primaryVerdict) {
    const buddyModel = defaultFallbackModel(model) || 'qwen3.7-plus';
    const buddyPrompt = buildPrompt({
      taskText: [
        `## BUDDY CROSS-VERIFICATION`,
        `Another model (${result.model}) reviewed the same code and returned:`,
        `VERDICT: ${primaryVerdict}`,
        ``,
        `Their rationale:`,
        primaryOutput.slice(0, 800),
        ``,
        `## YOUR TASK`,
        `Give your INDEPENDENT second opinion. Review the same evidence below.`,
        `Do you AGREE or DISAGREE with the ${result.model} verdict?`,
        ``,
        taskText,
      ].join('\n'),
      requireVerdict: true,
      lens: 'general',
      maxTokens: maxTokens ? Math.floor(maxTokens / 2) : undefined,
    });

    try {
      const buddyResult = await invokeWithFallback({
        model: buddyModel, prompt: DELEGATED_IDENTITY_PREFIX + buddyPrompt,
        timeoutMs, env, cwd, noFallback: true,
      });
      const buddyRaw = buddyResult.commandOutput || parseOpenCodeJsonl(buddyResult.stdout);
      const buddyOut = validateAssistantOutput(buddyRaw, { requireVerdict: true });
      const buddyOutput = typeof buddyOut === 'string' ? buddyOut : JSON.stringify(buddyOut);
      const buddyVerdict = (buddyOutput.match(/VERDICT\s*:\s*(APPROVED|WARNING|BLOCKED)/i) || [])[1]?.toUpperCase();

      await logAttemptResult({
        provider: buddyResult.provider || 'unknown', model: buddyModel, attemptIndex: attemptIndex++,
        outcome: 'success', durationMs: 0, timeoutMs, reasonCode: 'ok',
        outputBytes: Buffer.byteLength(buddyOutput, 'utf8'), tokensUsed: buddyResult.tokensUsed || null,
        classification: buddyVerdict
          ? classifyFailure(null, { verdict: buddyVerdict })
          : { class: 'no-judgment', subclass: null, locus: null, mechanism: null, censored: false, http_status: null, retry_after: null },
      });

      if (buddyVerdict) {
        const agreement = buddyVerdict === primaryVerdict;
        await logEvent('cross.verify', {
          run_id: runId,
          primary_verdict: primaryVerdict,
          primary_model: result.model,
          buddy_verdict: buddyVerdict,
          buddy_model: buddyModel,
          agreement,
        });

        if (!agreement) {
          const combinedOutput = [
            `VERDICT: WARNING`,
            ``,
            `BUDDIES DISAGREE — manual review recommended.`,
            ``,
            `${result.model} (primary): ${primaryVerdict}`,
            primaryOutput.slice(0, 400),
            ``,
            `${buddyModel} (buddy): ${buddyVerdict}`,
            buddyOutput.slice(0, 400),
          ].join('\n');
          return withContract({ ...result, output: combinedOutput, metadata, run_id: runId, cross_verify: { primary: { model: result.model, verdict: primaryVerdict }, buddy: { model: buddyModel, verdict: buddyVerdict }, agreement: false } });
        }

        // Agreement — note buddy concurrence
        const agreedOutput = jsonMode ? result.output : `${result.output}\n\n→ Buddy ${buddyModel} CONCURS: ${buddyVerdict}`;
        return withContract({ ...result, output: agreedOutput, metadata, run_id: runId, cross_verify: { primary: { model: result.model, verdict: primaryVerdict }, buddy: { model: buddyModel, verdict: buddyVerdict }, agreement: true } });
      }
    } catch {
      // Buddy check failed — don't block, just note
      await logEvent('cross.verify', { run_id: runId, primary_verdict: primaryVerdict, buddy_available: false });
    }
  }

  return withContract({ ...result, metadata, run_id: runId });
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

// ── FOUR-WAY CALLER CONTRACT (#11) ──
// ocask exposes FOUR outcomes and signals each BOTH via the process exit code AND
// a self-describing --json stdout object (redundant agreeing signals). Exit 0 is
// reserved for a positively-produced, parseable verdict — never for a failure, an
// empty/unparseable result, or a thrown run. Bands avoid shell-reserved codes
// (2, 126, 127, 128, 130).
//   APPROVED  -> exit 0
//   WARNING   -> exit 0   (proceed; told apart from APPROVED only via the JSON verdict)
//   BLOCKED   -> exit 20   (a rendered "no" is NOT "could not judge")
//   no-judgment (any infra/failure/could-not-judge) -> exit 30
export const EXIT_CODE = Object.freeze({ APPROVED: 0, WARNING: 0, BLOCKED: 20, NO_JUDGMENT: 30 });

// Map a produced outcome to its exit-code band. The ONLY routes to exit 0 are a
// real verdict (APPROVED/WARNING) or a freeform success that simply was not asked
// to judge (failed=false, no verdict). A thrown/failed run with no verdict is
// no-judgment -> 30. BLOCKED is its own band, distinct from 30.
export function exitCodeForOutcome({ verdict, failed = false }) {
  if (verdict === 'BLOCKED') return EXIT_CODE.BLOCKED;
  if (verdict === 'APPROVED' || verdict === 'WARNING') return EXIT_CODE.APPROVED;
  return failed ? EXIT_CODE.NO_JUDGMENT : 0;
}

// Build the full outcome descriptor from which BOTH the exit code and the --json
// object are derived (single source of truth → guaranteed agreement). reason/
// locus/mechanism describe WHY there is no judgment, so they come from
// classifyFailure(error) on a failure and stay null otherwise.
// NOTE on the three non-BLOCKED labels: a real verdict is "judgment"; a FAILURE is
// "no-judgment" (exit 30); a freeform success (no --require-verdict, no verdict, did
// not fail) is "analysis" with verdict:null and exit 0. Keeping freeform as its own
// label reserves "no-judgment" strictly for failures, so a caller never observes the
// contradictory pair outcome:"no-judgment" with exit 0.
export function describeOutcome({ verdict, output = null, classification = null, failed = false }) {
  const v = (verdict === 'APPROVED' || verdict === 'WARNING' || verdict === 'BLOCKED') ? verdict : null;
  const reason = failed ? (classification?.subclass ?? null) : null;
  const locus = failed ? (classification?.locus ?? null) : null;
  const mechanism = failed ? (classification?.mechanism ?? null) : null;
  return {
    outcome: v ? 'judgment' : (failed ? 'no-judgment' : 'analysis'),
    verdict: v,
    reason,
    locus,
    mechanism,
    exit_code: exitCodeForOutcome({ verdict: v, failed }),
    output,
  };
}

// Render the self-describing --json stdout object. The machine fields
// (outcome/verdict/reason/locus/mechanism/exit_code) are first-class so a caller
// that never sees stderr still gets the full outcome; the human model text rides
// under "output" so nothing is lost. exit_code always equals the process exit
// code (redundant agreeing signal).
export function buildJsonResponse(descriptor) {
  return {
    outcome: descriptor.outcome,
    verdict: descriptor.verdict,
    reason: descriptor.reason,
    locus: descriptor.locus,
    mechanism: descriptor.mechanism,
    exit_code: descriptor.exit_code,
    output: descriptor.output ?? null,
  };
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

    const runAskFn = providedRunAsk || runAsk;
    const result = await runAskFn({
      model: args.model, taskText, systemText, contextText,
      jsonMode: args.json === true, requireVerdict: args['require-verdict'] === true,
      noFallback, crossVerify: args['cross-verify'] === true,
      lens, provider, temperature, maxTokens, timeoutMs,
      fallbackModel: args['fallback-model'], cwd, env,
    });

    if (args.metadata) await writeAtomicPrivate(args.metadata, JSON.stringify(result.metadata || {}) + '\n');

    // Four-way caller contract (#11): derive the outcome from the produced verdict
    // (or freeform success) and set the process exit band. Exit 0 requires a real
    // verdict; BLOCKED is 20; a no-judgment is 30. The --json object mirrors the band.
    const humanOutput = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    const descriptor = describeOutcome({
      verdict: result.verdict || null,
      output: humanOutput,
      classification: result.classification || null,
      failed: false,
    });
    process.exitCode = descriptor.exit_code;
    if (args.json) writeStdout(JSON.stringify(buildJsonResponse(descriptor)));
    else writeStdout(humanOutput);
  } catch (error) {
    const cause = error?.message || 'delegation failed';
    // A throw means no usable verdict was produced -> no-judgment (exit 30; NEVER 0
    // or 1). Derive reason/locus/mechanism from classifyFailure(error) (it unwraps
    // the factory wrapper to the true mechanism) so a --json caller sees the full
    // outcome without stderr. Applies to provider failures AND usage/arg throws.
    const classification = classifyFailure(error);
    const descriptor = describeOutcome({ verdict: null, output: null, classification, failed: true });
    process.exitCode = descriptor.exit_code;
    writeStderr(`ocask error: ${cause}`); // human line retained for non-json callers
    if (argv.includes('--json')) writeStdout(JSON.stringify(buildJsonResponse(descriptor)));
    if (args?.metadata && error?.ocaskMetadata) {
      await writeAtomicPrivate(args.metadata, JSON.stringify(error.ocaskMetadata) + '\n').catch(() => {});
    }
  }
}

async function main() {
  // Fire-and-forget version check (non-blocking, prints to stderr)
  notifyUpgrade().catch(() => {});

  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  const jsonOutput = argv.includes('--json');

  if (subcommand === 'doctor') {
    const report = await doctorReport({ system: true });
    if (jsonOutput) console.log(JSON.stringify(report));
    else {
      console.log(formatDoctor(report));
      if (report.system) console.log('\n' + (await import('./system.mjs')).formatSystemHealth(report.system));
    }
    return;
  }

  if (subcommand === 'diagnose') {
    const runIdIdx = argv.indexOf('--run-id');
    const runId = runIdIdx >= 0 ? argv[runIdIdx + 1] : null;
    if (!runId) { console.error('Usage: ocask diagnose --run-id <id>'); process.exitCode = 1; return; }
    const diag = await diagnoseRun(runId);
    console.log(JSON.stringify(diag, null, 2));
    return;
  }

  if (subcommand === 'cost') {
    const refreshFlag = argv.includes('--refresh');
    const runIdIdx = argv.indexOf('--run-id');
    const runId = runIdIdx >= 0 ? argv[runIdIdx + 1] : null;
    const pricing = await getPricing(refreshFlag);

    if (runId) {
      const diag = await diagnoseRun(runId);
      if (diag.status === 'not_found') { console.error(`Run ${runId} not found.`); process.exitCode = 1; return; }
      const tokens = diag.attempts?.filter(a => a.outcome === 'success') || [];
      let totalIn = 0, totalOut = 0;
      for (const a of tokens) { const t = a.tokens || {}; totalIn += t.input || 0; totalOut += t.output || 0; }
      const cost = calculateCost(totalIn, totalOut, diag.model, pricing);
      console.log(jsonOutput ? JSON.stringify(cost) : formatCost(cost));
      return;
    }
    const entries = await readLog();
    const summary = await cumulativeCost(pricing, entries);
    console.log(jsonOutput ? JSON.stringify(summary) : formatCumulativeCost(summary));
    return;
  }

  if (subcommand === 'pricing') {
    const refreshFlag = argv.includes('--refresh');
    const pricing = await getPricing(refreshFlag);
    console.log(jsonOutput ? JSON.stringify(pricing) : formatPricingTable(pricing));
    return;
  }

  if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
    console.log(`ocask ${CURRENT_VERSION}`);
    return;
  }

  if (subcommand === 'upgrade') {
    const { checkVersion } = await import('./version.mjs');
    const v = await checkVersion({ force: true });
    if (v.upgrade) console.log(`Upgrade available: ${v.current} → ${v.latest}\n  git -C ~/ocask pull && ~/ocask/install.sh`);
    else console.log(`Already at latest: ${v.current}`);
    return;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log(`ocask v0.1 — OpenCode Analytical Scrutiny Kit

Subcommands:
  ocask [args]                Run a review (default)
  ocask doctor                Provider health, flake detection, system checks. Use --json for structured output.
  ocask diagnose --run-id <id>  Deep-dive a specific invocation
  ocask cost [--run-id <id>] [--refresh] [--json]  Cumulative or per-run cost
  ocask pricing [--refresh] [--json]                Current pricing table
  ocask upgrade               Check for new version
  ocask help                  This message

Run args:
  ${USAGE}`);
    return;
  }

  // Default: run mode
  await runMain(argv);
}

// ── Doctor text formatter ──
function formatDoctor(report) {
  if (report.status === 'empty') return report.message;
  const s = report.summary;
  const lines = [`ocask doctor — ${s.total_runs} runs, ${s.successful} successful, ${s.failed} failed`];
  if (s.partial_crashes > 0) lines.push(`  ${s.partial_crashes} partial crashes (runs with no verdict/error — check for interrupt/timeout)`);
  lines.push(`  Verdicts: ${s.verdict_distribution?.APPROVED || 0}A / ${s.verdict_distribution?.WARNING || 0}W / ${s.verdict_distribution?.BLOCKED || 0}B`);
  lines.push(`  Tokens: ${(s.total_tokens || 0).toLocaleString()} | ${s.date_range}`);
  lines.push('');

  lines.push('Providers:');
  for (const p of report.providers || []) {
    lines.push(`  ${p.provider_model}: ${p.success_rate} (${p.success}/${p.total}), ${p.avg_latency_ms}ms avg, ${(p.total_tokens || 0).toLocaleString()} tokens`);
    for (const [code, count] of Object.entries(p.error_breakdown || {})) lines.push(`    ${code}: ${count}`);
  }

  if (report.models?.length) {
    lines.push('');
    lines.push('Models:');
    for (const m of report.models) lines.push(`  ${m.model}: ${m.success_rate} (${m.success}/${m.total}), ${m.avg_latency_ms}ms avg`);
  }

  if (report.trend?.length > 1) {
    lines.push('');
    lines.push('Trend:');
    for (const d of report.trend) lines.push(`  ${d.date}: ${d.success_rate} (${d.total} attempts, ${(d.tokens || 0).toLocaleString()} tokens)`);
  }

  if (report.flakes?.length) {
    lines.push('');
    lines.push('Flakes:');
    for (const f of report.flakes) lines.push(`  ${f.run_id.slice(0,8)}: ${f.flaky_provider}/${f.flaky_model} → ${f.recovered_by}/${f.recovered_model} [${f.error_code}]`);
  }

  if (report.suggestions?.length) {
    lines.push('');
    lines.push('Suggestions:');
    for (const s of report.suggestions) lines.push(`  [${s.severity}] ${s.action}`);
  }
  return lines.join('\n');
}
// `process.argv[1]` is the path as invoked — the symlink itself under an
// `ln -s` install — while `import.meta.url` is always the resolved real path.
// Both sides must be realpath'd or main() never runs and the CLI exits 0 with
// no output. fileURLToPath also handles paths containing spaces.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) { main(); }
