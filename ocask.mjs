#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isPaidModelAllowed, PAID_MODELS } from './ocverify.mjs';

const AI_FLOW_DIR = '/home/soultransit/.local/share/ai-flow';
const LEAF_SHIM_DIR = `${AI_FLOW_DIR}/leaf-shims`;

// Resolve a command to an absolute path on a given PATH (so the runner can spawn
// its real CLI directly, bypassing the leaf shim PATH prepended for the child).
function resolveOnPath(name, envPath) {
  for (const d of String(envPath || '').split(':')) {
    if (!d) continue;
    const cand = path.join(d, name);
    try {
      const st = fsSync.statSync(cand);
      if (st.isFile()) {
        fsSync.accessSync(cand, fsSync.constants.X_OK);
        return cand;
      }
    } catch { /* not here */ }
  }
  return null;
}

// Best-effort: install the terminal-leaf rejector shims via the shared facility.
function ensureLeafShims() {
  try { spawnSync('python3', [`${AI_FLOW_DIR}/leaf.py`, 'ensure-shims'], { stdio: 'ignore' }); } catch { /* fail-open */ }
}

// Terminal-leaf boundary for the opencode child env. The runner spawns its real
// opencode via an absolute path, so the shim PATH only constrains the model
// child's own subprocess calls.
function leafChildEnv(baseEnv, surface) {
  const env = { ...baseEnv };
  ensureLeafShims();
  env.AI_FLOW_LEAF = '1';
  env.AI_FLOW_TRACE = randomBytes(16).toString('hex');
  env.AI_FLOW_PARENT_TRACE = baseEnv.AI_FLOW_TRACE || '';
  env.AI_FLOW_SURFACE = surface;
  env.PATH = `${LEAF_SHIM_DIR}:${env.PATH || ''}`;
  return env;
}

// Best-effort lifecycle telemetry (fail-open). Privacy-safe structured fields only.
function emitTelemetry(record) {
  try {
    const args = ['emit', '--surface', String(record.surface ?? 'opencode'),
      '--role', String(record.role ?? 'deepseek'), '--event', String(record.event ?? 'other'),
      '--phase', String(record.phase ?? 'leaf')];
    const map = { trace: 'trace', parent_trace: 'parent_trace', model: 'model',
      duration_ms: 'duration_ms', input_bytes: 'input_bytes', output_bytes: 'output_bytes',
      exit_code: 'exit_code', verdict: 'verdict', fallback_from: 'fallback_from',
      fallback_to: 'fallback_to', reason_code: 'reason_code' };
    for (const [k, cli] of Object.entries(map)) {
      const v = record[k];
      if (v !== undefined && v !== null && v !== '') args.push(`--${cli}`, String(v));
    }
    spawnSync('python3', [`${AI_FLOW_DIR}/telemetry.py`, ...args], { stdio: 'ignore' });
  } catch { /* fail-open */ }
}

// 0 disables the per-stream output cap: the default is unbounded (no artificial
// bottleneck). A caller can still inject a positive maxOutputBytes to opt into
// bounded capture, which runBoundedCommand enforces.
const MAX_OUTPUT_BYTES = 0;
const KILL_GRACE_MS = 1000;
const MAX_PLAUSIBLE_PATH_LENGTH = 4096;
const SERVER_START_WAIT_MS = 15000;
const SERVER_HEALTH_TIMEOUT_MS = 1000;
const SERVER_POLL_MS = 50;
const SERVER_LOCK_STALE_MS = 30000;
const SERVER_STATE_VERSION = 2;

export const USAGE = 'Usage: ocask --model <id> --task <path|-|string> [--system <path|-|string>] [--context <path|-|string>] [--json] [--require-verdict] [--no-fallback] [--lens code-review|architecture|security|tdd|maintainability|deep-modules|general] [--metadata <path>] [--temperature 0] [--max-tokens N] [--timeout-ms N] [--fallback-model <id>]';

const BOOLEAN_ARGS = new Set(['json', 'require-verdict', 'no-fallback']);
const VALUE_ARGS = new Set([
  'model',
  'task',
  'system',
  'context',
  'lens',
  'metadata',
  'temperature',
  'max-tokens',
  'timeout-ms',
  'fallback-model'
]);

const CHILD_ENV = Object.freeze({
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_PERMISSION: '{"*":"allow"}'
});

// Prepended to every prompt at the OpenCode transport boundary, mirroring the
// glm-exec and codex-exec identity markers. Native tools and native subagents
// stay fully allowed, but every native subagent must inherit the marker and no
// recursive external model runner may be invoked.
export const DELEGATED_IDENTITY_PREFIX = `[DELEGATED_RUNNER_IDENTITY]
You are the delegated OpenCode Go worker. Execute the supplied task directly. Native OpenCode tools and native subagents remain allowed with full approved capabilities for the scoped task; every native subagent you launch must inherit this delegated marker and the external-runner recursion ban. Do not recursively invoke external model runners or delegates, including codex, codex-exec, glm-exec, ocask, raw codex, claude, opencode, or external-model MCP delegation.
[/DELEGATED_RUNNER_IDENTITY]

`;

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isEntitlementUnavailable(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return /not supported on the lite model list|model_not_supported/i.test(text);
}

function entitlementUnavailableError() {
  return makeError(
    'OpenCode Go paid-model entitlement is unavailable: the backend classified this key as Lite. Catalog presence does not prove entitlement. Causes include a stale or wrong Go key, a provider entitlement bug, or an actual usage limit. If the Go console is below its limits, reconnect OpenCode Go with a freshly generated Go API key and retry; otherwise report the issue to OpenCode. Reroute this review to Codex or standalone GLM.',
    'GO_ENTITLEMENT_UNAVAILABLE'
  );
}

function parsePositiveInt(value, label, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseTemperature(value) {
  if (value === undefined) return 0;
  const temperature = Number(value);
  if (!Number.isFinite(temperature)) {
    throw new Error('--temperature must be 0');
  }
  if (temperature !== 0) {
    throw new Error('--temperature only supports 0 because the OpenCode CLI has no supported temperature flag');
  }
  return temperature;
}

function formatAllowedModelError(label, model) {
  const models = PAID_MODELS.filter((candidate) => modelFamily(candidate));
  return `${label} ${model || '(missing)'} is not allowed. ocask supports paid DeepSeek/Qwen models only. Allowed models: ${models.join(', ')}`;
}

function modelFamily(model) {
  if (model?.startsWith('deepseek-')) return 'deepseek';
  if (model?.startsWith('qwen')) return 'qwen';
  return null;
}

export function parseArgs(argv) {
  const result = Object.create(null);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    if (BOOLEAN_ARGS.has(key)) {
      result[key] = true;
      continue;
    }
    if (!VALUE_ARGS.has(key)) {
      throw new Error(`Unknown option: --${key}`);
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

export function guardAllowedModels({ model, fallbackModel }) {
  if (!isPaidModelAllowed(model) || !modelFamily(model)) {
    throw new Error(formatAllowedModelError('Model', model));
  }

  if (fallbackModel && (!isPaidModelAllowed(fallbackModel) || !modelFamily(fallbackModel))) {
    throw new Error(formatAllowedModelError('Fallback model', fallbackModel));
  }

  if (fallbackModel) {
    if (fallbackModel === model) {
      throw new Error('Fallback model must be different from the primary model');
    }
    const primaryFamily = modelFamily(model);
    const fallbackFamily = modelFamily(fallbackModel);
    if (!primaryFamily || !fallbackFamily || primaryFamily === fallbackFamily) {
      throw new Error('Fallback model must be from the opposite DeepSeek/Qwen family');
    }
  }

  return true;
}

export function defaultFallbackModel(model) {
  if (modelFamily(model) === 'deepseek') return 'qwen3.7-plus';
  if (modelFamily(model) === 'qwen') return 'deepseek-v4-flash';
  return undefined;
}

export function buildPrompt({
  taskText,
  systemText = '',
  contextText = '',
  jsonMode = false,
  requireVerdict = false,
  maxTokens,
  lens = 'general'
}) {
  const isReview = requireVerdict;
  const sections = [];
  if (systemText.trim()) {
    sections.push(`## SYSTEM INSTRUCTIONS\n${systemText.trim()}`);
  }
  sections.push(`## TASK\n${taskText.trim()}`);
  if (contextText.trim()) {
    sections.push(`## CONTEXT\n${contextText.trim()}`);
  }

  // Audit lens: structured analytical frameworks for DeepSeek's reasoning strength.
  if (isReview && lens !== 'general') {
    sections.push(`## AUDIT FRAMEWORK — ${lens.toUpperCase()}
Apply this lens when analyzing the evidence. Consider each angle explicitly.${LENS_FRAMEWORKS[lens] || ''}`);
  }

  const contract = [];
  if (jsonMode && requireVerdict) {
    contract.push(
      'Return exactly one JSON object and no Markdown fence or surrounding text.',
      'The object must contain "verdict" with one of: APPROVED, WARNING, BLOCKED.',
      'The object must also contain a separate "reason", "reasoning", or "summary" string with an alphabetic rationale.',
      'This is a review-only task: do not modify files or external state. Read-only inspection and non-mutating verification tools remain available.'
    );
  } else if (jsonMode) {
    contract.push(
      'Return exactly one JSON object and no Markdown fence or surrounding text.',
      'Include meaningful alphabetic content; do not return only numbers or punctuation.'
    );
  } else if (requireVerdict) {
    const rationale = lens !== 'general'
      ? 'Provide a separate alphabetic prose rationale organized by the audit dimensions above.'
      : 'Provide a separate alphabetic prose rationale.';
    contract.push(
      'Near the top, include exactly one line containing: VERDICT: APPROVED, VERDICT: WARNING, or VERDICT: BLOCKED.',
      rationale,
      'WARNING and BLOCKED are valid review outcomes; choose the verdict that the evidence supports.',
      'This is a review-only task: do not modify files or external state. Read-only inspection and non-mutating verification tools remain available.'
    );
  } else {
    contract.push('Return a direct answer containing alphabetic prose; do not return only numbers or punctuation.');
  }
  if (maxTokens !== undefined) {
    contract.push(`Advisory response limit: keep the response within approximately ${maxTokens} tokens.`);
  }
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
  default: [
    'Answer directly. Inspect only the evidence needed, and avoid unrelated discovery or delegation; use available tools when they materially help.',
  ].join('\n'),
};

const LENS_FRAMEWORKS = {
  'code-review': `
- **Correctness**: Does the logic hold for all inputs including edge cases and error paths?
- **Completeness**: Are all spec requirements addressed? Any missing branches, null checks, or error handling?
- **Consistency**: Does this match the codebase's existing patterns, conventions, and idioms?
- **Simplicity**: Could this be simpler without losing correctness? Any unnecessary abstraction or indirection?
- **Code smells** — scan for Fowler's catalogue:
  - *Mysterious Name*: names that don't reveal intent → rename; if no honest name comes, the design is murky.
  - *Duplicated Code*: same logic shape in multiple hunks → extract and call from both.
  - *Feature Envy*: method reaching into another object's data more than its own → move it.
  - *Data Clumps*: same fields/params traveling together → bundle into a type.
  - *Primitive Obsession*: primitives/strings standing in for domain concepts → give them their own type.
  - *Repeated Switches*: same switch/if-cascade recurring → replace with polymorphism or a shared map.
  - *Shotgun Surgery*: one logical change scattering edits across many files → gather into one module.
  - *Divergent Change*: one file edited for unrelated reasons → split it.
  - *Speculative Generality*: abstractions/hooks for needs the spec doesn't have → inline until a real need shows.
  - *Message Chains*: long a.b().c().d() navigation → hide the walk behind one method.
  - *Middle Man*: class/function that mostly delegates → cut it, call the real target.
  - *Refused Bequest*: subclass ignoring most of what it inherits → use composition instead.`,

  'architecture': `
- **Module boundaries**: Does the change respect existing seams or leak responsibilities across modules?
- **Coupling and cohesion**: Does it increase coupling? Is new code cohesive with its neighbors?
- **Deep vs shallow modules** (Ousterhout / Pocock):
  - *Deep module*: small interface + lots of implementation → high leverage and locality.
  - *Shallow module*: interface nearly as complex as the implementation → avoid.
  - Apply the *deletion test*: if you deleted this module, would complexity reappear across N callers (earning its keep) or just vanish (pass-through)?
- **Seams** (Feathers): places where you can alter behaviour without editing in that place. Are seams at the right granularity?
  - *One adapter = hypothetical seam. Two adapters = real one.* Don't introduce seams without variation.
  - *The interface IS the test surface.* Tests should cross the same seam as callers.
- **Change amplification**: Will a future change in one place require cascading edits elsewhere?
- **Locality**: Do change, bugs, and verification concentrate in one place, or spread across callers?
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
- **Anti-patterns to flag aggressively**:
  - *Implementation-coupled*: test mocks internals, tests private methods, or verifies through side channels. The tell: it breaks on refactor when behaviour hasn't changed.
  - *Tautological*: assertion recomputes expected value the same way the code does → passes by construction, can never disagree. Expected values must come from an independent source of truth.
  - *Horizontal slicing*: all tests written first, then all implementation. This locks in imagined structure before the implementation teaches you the right shape. Prefer *vertical slices* — one test, one implementation, repeat.`,

  'maintainability': `
This is a thermo-nuclear code quality audit. Be ambitious — search for "code judo" moves that make the implementation dramatically simpler, smaller, and more elegant. Do not rubber-stamp working code that leaves the codebase messier.

- **Code judo**: Is there a restructuring that preserves behavior but deletes whole categories of complexity? Prefer solutions that make the code feel inevitable in hindsight.
- **File size boundary (1K lines)**: Did this push a file past 1000 lines without a very strong reason? Prefer extracting helpers, sub-modules, or local abstractions instead of letting files sprawl.
- **Spaghetti growth**: Be highly suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows. Push logic into dedicated abstractions instead.
- **Directness**: Prefer direct, boring, maintainable code over hacky, magical, or clever code. Flag thin wrappers, identity abstractions, or pass-through helpers that add indirection without clarity.
- **Type and boundary cleanliness**: Question unnecessary optionality, \`unknown\`, \`any\`, or cast-heavy code. Prefer explicit typed contracts over loosely-shaped ad-hoc objects.
- **Canonical layer discipline**: Is logic in the right file and package? Call out feature logic leaking into shared paths. Prefer existing canonical utilities over bespoke one-offs.
- **Orchestration complexity**: Is independent work unnecessarily serialized? Can related updates leave state half-applied? Flag avoidable orchestration complexity that makes the implementation more brittle.
- **Approval bar**: Do not approve merely because behavior is correct. The bar is: no clear structural regression, no obvious missed simplification opportunity, no unjustified file-size explosion, and no clear spaghetti-growth from special-case branching.`,

  'deep-modules': `
Audit modules for *depth* — the amount of behavior behind a small interface. Use the codebase-design vocabulary precisely.

- **Interface audit**: What must a caller know to use each affected module correctly? Count methods, parameters, invariants, ordering constraints, error modes, and config. Is the interface smaller than the implementation?
- **Deletion test**: For each module touched by this change — if you deleted it entirely, would its complexity reappear across N callers (it earns its keep), or would it simply vanish (it was a pass-through)?
- **Seam placement**: Where does each module's interface live? Is the seam at the right granularity? Does it accept dependencies (testable) or create them (hard to test)? Does it return results (testable) or produce side effects (hard to test)?
- **Shallow module detection**: Identify any module where the interface is nearly as complex as the implementation. These are pass-throughs or thin wrappers — can the interface be collapsed?
- **Deepening opportunities**: Can you reduce the number of methods? Can you simplify parameters? Can more complexity be hidden behind the interface? Each simplification produces *leverage* (more capability per unit of interface) and *locality* (changes concentrate in one place).
- **Internal seams**: A deep module can be internally composed of small, mockable parts — they just aren't part of the public interface. Are internal seams testable without leaking into the public contract?
- **Adapter discipline**: One adapter = hypothetical seam. Two adapters = real one. Don't introduce seams without actual variation.`,
};

const VALID_LENSES = ['general'].concat(Object.keys(LENS_FRAMEWORKS));

// Kept as a compatibility helper for callers that previously assembled chat messages.
export function buildMessages({ taskText, systemText = '', contextText = '' }) {
  const messages = [];
  if (systemText) messages.push({ role: 'system', content: systemText });
  messages.push({
    role: 'user',
    content: contextText ? `${taskText}\n\nContext:\n${contextText}` : taskText
  });
  return messages;
}

export function parseOpenCodeJsonl(stdout) {
  const textParts = [];
  const seenPartIds = new Set();
  let textEventCount = 0;

  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // OpenCode can print diagnostic lines around its JSONL stream. They are
      // never assistant output, so ignore them and require a real text event.
      continue;
    }

    if (event?.type === 'error' || event?.part?.type === 'error') {
      if (isEntitlementUnavailable(event)) throw entitlementUnavailableError();
      throw makeError('OpenCode emitted an error event', 'OPENCODE_EVENT_ERROR');
    }

    const part = event?.part;
    if (event?.type !== 'text' || part?.type !== 'text' || typeof part.text !== 'string') {
      continue;
    }

    textEventCount += 1;
    if (part.id !== undefined && part.id !== null) {
      const id = String(part.id);
      if (seenPartIds.has(id)) continue;
      seenPartIds.add(id);
    }
    textParts.push(part.text);
  }

  if (textEventCount === 0) {
    throw makeError('OpenCode JSONL contained no assistant text event', 'MODEL_OUTPUT');
  }
  return textParts.join('\n');
}

export function extractJsonObject(raw) {
  if (typeof raw !== 'string') {
    throw makeError('Model content is not a string', 'MODEL_OUTPUT');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw makeError('Model content is empty', 'MODEL_OUTPUT');
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw makeError('Could not parse model content as one JSON object', 'MODEL_OUTPUT');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw makeError('Model JSON content is not an object', 'MODEL_OUTPUT');
  }
  return parsed;
}

function hasLetter(value) {
  return /\p{L}/u.test(value);
}

export function validateAssistantOutput(raw, { jsonMode = false, requireVerdict = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw makeError('Model output is empty or whitespace-only', 'MODEL_OUTPUT');
  }
  const trimmed = raw.trim();

  if (jsonMode) {
    const object = extractJsonObject(trimmed);
    if (!hasLetter(trimmed)) {
      throw makeError('Model output must contain alphabetic content, not only numbers or punctuation', 'MODEL_OUTPUT');
    }
    if (requireVerdict) {
      if (typeof object.verdict !== 'string' || !/^(APPROVED|WARNING|BLOCKED)$/i.test(object.verdict.trim())) {
        throw makeError('JSON review output must contain verdict APPROVED, WARNING, or BLOCKED', 'MODEL_OUTPUT');
      }
      const rationale = ['reason', 'reasoning', 'summary']
        .map((key) => object[key])
        .find((value) => typeof value === 'string' && hasLetter(value));
      if (!rationale) {
        throw makeError('JSON review output must contain an alphabetic reason, reasoning, or summary rationale', 'MODEL_OUTPUT');
      }
    }
    return object;
  }

  if (!hasLetter(trimmed)) {
    throw makeError('Model output must contain alphabetic content, not only numbers or punctuation', 'MODEL_OUTPUT');
  }

  if (requireVerdict) {
    const nonemptyLines = trimmed.split(/\r?\n/).filter((line) => line.trim());
    const candidates = nonemptyLines.map((line, index) => {
      const canonical = line.trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-+*]\s+/, '')
        .replace(/[\*_`]/g, '')
        .trim();
      const match = /^VERDICT\s*:\s*(APPROVED|WARNING|BLOCKED)\s*[.!]?$/i.exec(canonical);
      return match ? { index, verdict: match[1].toUpperCase() } : null;
    }).filter(Boolean);
    if (candidates.length !== 1) {
      throw makeError('Review output must contain exactly one explicit VERDICT: APPROVED, WARNING, or BLOCKED', 'MODEL_OUTPUT');
    }
    if (candidates[0].index >= 5) {
      throw makeError('Review output explicit VERDICT line must appear within the first five nonempty lines', 'MODEL_OUTPUT');
    }
    const rationale = nonemptyLines.filter((_, index) => index !== candidates[0].index).join('\n');
    if (!hasLetter(rationale)) {
      throw makeError('Review output must include a separate alphabetic prose rationale', 'MODEL_OUTPUT');
    }
  }

  return trimmed;
}

function defaultRuntimeDir(env = process.env) {
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'ocask');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `ocask-${uid}`);
}

async function ensurePrivateRuntimeDir(runtimeDir) {
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(runtimeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw makeError('ocask runtime path is not a private directory', 'SERVER_SETUP');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw makeError('ocask runtime directory is not owned by the current user', 'SERVER_SETUP');
  }
  await fs.chmod(runtimeDir, 0o700);
}

function statePaths(runtimeDir) {
  return {
    statePath: path.join(runtimeDir, 'server-state.json'),
    lockPath: path.join(runtimeDir, 'server-start.lock')
  };
}

function validServerState(state) {
  return state?.schema === SERVER_STATE_VERSION
    && Number.isInteger(state.pid) && state.pid > 0
    && Number.isInteger(state.port) && state.port > 0 && state.port < 65536
    && typeof state.password === 'string' && state.password.length >= 32
    && typeof state.version === 'string' && state.version.length > 0;
}

async function readServerState(runtimeDir) {
  const { statePath } = statePaths(runtimeDir);
  try {
    const stat = await fs.lstat(statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return validServerState(state) ? state : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeServerState(runtimeDir, state, randomBytesImpl = randomBytes) {
  const { statePath } = statePaths(runtimeDir);
  const suffix = randomBytesImpl(8).toString('hex');
  const tempPath = path.join(runtimeDir, `server-state.${process.pid}.${suffix}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await fs.rename(tempPath, statePath);
    await fs.chmod(statePath, 0o600);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function basicAuth(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

export async function probeServerHealth(state, {
  fetchImpl = fetch,
  pidAliveImpl = isPidAlive,
  healthTimeoutMs = SERVER_HEALTH_TIMEOUT_MS
} = {}) {
  if (!state || !pidAliveImpl(state.pid)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${state.port}/global/health`, {
      headers: { Authorization: basicAuth(state.password) },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload?.healthy !== true || typeof payload.version !== 'string' || !payload.version) return null;
    if (state.version && payload.version !== state.version) return null;
    return { version: payload.version };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function healthyStoredServer(runtimeDir, options) {
  const { statePath } = statePaths(runtimeDir);
  let state = await readServerState(runtimeDir);
  if (!state) {
    try {
      await fs.lstat(statePath);
      // The atomic state rename may have raced the first read. Re-read once
      // before classifying an existing state file as invalid.
      state = await readServerState(runtimeDir);
      if (!state) {
        throw makeError('Persistent server state is invalid; using direct mode without replacing a possibly live server', 'SERVER_SETUP');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  const health = await probeServerHealth(state, options);
  if (!health) {
    if (options.pidAliveImpl(state.pid)) {
      throw makeError('Recorded persistent server is alive but unhealthy; using direct mode without orphaning it', 'SERVER_SETUP');
    }
    await fs.rm(statePath, { force: true });
    return null;
  }
  return {
    ...state,
    url: `http://127.0.0.1:${state.port}`,
    cold: false
  };
}

export function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(makeError('Could not reserve a loopback port', 'SERVER_SETUP'));
        else resolve(port);
      });
    });
  });
}

export function launchPersistentServer({ port, password, runtimeDir, env, opencodeBin, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    if (!path.isAbsolute(opencodeBin || '')) {
      reject(makeError('Persistent server requires an absolute OpenCode executable', 'SERVER_SETUP'));
      return;
    }
    let child;
    try {
      child = spawnImpl(
        opencodeBin,
        ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
        {
          cwd: runtimeDir,
          env: {
            ...env,
            ...CHILD_ENV,
            OPENCODE_SERVER_PASSWORD: password
          },
          shell: false,
          detached: process.platform !== 'win32',
          stdio: 'ignore'
        }
      );
    } catch (error) {
      reject(makeError(`Could not start persistent OpenCode server: ${error?.message || 'spawn failed'}`, 'SERVER_SETUP'));
      return;
    }
    child.once('error', (error) => reject(makeError(
      `Could not start persistent OpenCode server: ${error?.message || 'spawn failed'}`,
      'SERVER_SETUP'
    )));
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}

function signalPidTree(pid, signal) {
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    // The supervised server may already have exited.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleLock(lockPath, { nowImpl, pidAliveImpl }) {
  try {
    const stat = await fs.stat(lockPath);
    if (nowImpl() - stat.mtimeMs < SERVER_LOCK_STALE_MS) return false;
    let owner;
    try {
      owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    } catch {
      owner = null;
    }
    if (owner?.pid && pidAliveImpl(owner.pid)) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

export async function ensurePersistentServer({
  runtimeDir = defaultRuntimeDir(),
  inheritedEnv = process.env,
  fetchImpl = fetch,
  pidAliveImpl = isPidAlive,
  reservePortImpl = reserveLoopbackPort,
  serverLauncher = launchPersistentServer,
  randomBytesImpl = randomBytes,
  sleepImpl = delay,
  nowImpl = Date.now,
  startWaitMs = SERVER_START_WAIT_MS,
  pollMs = SERVER_POLL_MS,
  opencodeBin = resolveOnPath('opencode', inheritedEnv.PATH)
} = {}) {
  if (!path.isAbsolute(opencodeBin || '')) {
    throw makeError('Could not resolve the real OpenCode executable from the host PATH', 'SERVER_SETUP');
  }
  await ensurePrivateRuntimeDir(runtimeDir);
  const healthOptions = { fetchImpl, pidAliveImpl };
  const existing = await healthyStoredServer(runtimeDir, healthOptions);
  if (existing) return existing;

  const { lockPath } = statePaths(runtimeDir);
  const deadline = nowImpl() + startWaitMs;
  let lockHandle = null;

  while (!lockHandle) {
    try {
      lockHandle = await fs.open(lockPath, 'wx', 0o600);
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: nowImpl() })}\n`);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const shared = await healthyStoredServer(runtimeDir, healthOptions);
      if (shared) return shared;
      if (await removeStaleLock(lockPath, { nowImpl, pidAliveImpl })) continue;
      if (nowImpl() >= deadline) {
        throw makeError('Timed out waiting for the shared OpenCode server to start', 'SERVER_SETUP');
      }
      await sleepImpl(pollMs);
    }
  }

  let launched = null;
  try {
    const raced = await healthyStoredServer(runtimeDir, healthOptions);
    if (raced) return raced;
    const port = await reservePortImpl();
    const password = randomBytesImpl(32).toString('base64url');
    launched = await serverLauncher({
      port,
      password,
      runtimeDir,
      env: inheritedEnv,
      opencodeBin
    });
    if (!Number.isInteger(launched?.pid) || launched.pid <= 0) {
      throw makeError('Persistent OpenCode server did not return a valid PID', 'SERVER_SETUP');
    }

    const candidate = { pid: launched.pid, port, password };
    while (nowImpl() < deadline) {
      const health = await probeServerHealth(candidate, healthOptions);
      if (health) {
        const state = {
          schema: SERVER_STATE_VERSION,
          ...candidate,
          version: health.version,
          startedAt: new Date(nowImpl()).toISOString()
        };
        await writeServerState(runtimeDir, state, randomBytesImpl);
        return { ...state, url: `http://127.0.0.1:${port}`, cold: true };
      }
      await sleepImpl(pollMs);
    }
    throw makeError('Persistent OpenCode server failed its loopback health check', 'SERVER_SETUP');
  } catch (error) {
    if (launched?.pid) signalPidTree(launched.pid, 'SIGTERM');
    throw error;
  } finally {
    await lockHandle.close();
    await fs.rm(lockPath, { force: true });
  }
}

function signalChildTree(child, signal) {
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        // Fall through to the direct child if process-group signaling is not available.
      }
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the close check and the signal.
  }
}

const ACTIVE_SIGNAL_TERMINATORS = new Set();
const HOST_SIGNAL_HANDLERS = new Map();

function registerSignalTerminator(terminator) {
  if (ACTIVE_SIGNAL_TERMINATORS.size === 0) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        for (const active of [...ACTIVE_SIGNAL_TERMINATORS]) active(signal);
      };
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

export function runBoundedCommand({
  command,
  args,
  prompt,
  cwd,
  env,
  timeoutMs,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  spawnImpl = spawn,
  killGraceMs = KILL_GRACE_MS
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(makeError(`Could not start ${command}: ${error?.message || 'spawn failed'}`, error?.code || 'SPAWN'));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forcedError = null;
    let killTimer = null;
    let timeoutTimer = null;
    let unregisterSignals = () => {};

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      unregisterSignals();
      callback();
    };

    const terminate = (error) => {
      if (forcedError || settled) return;
      forcedError = error;
      signalChildTree(child, 'SIGTERM');
      killTimer = setTimeout(() => signalChildTree(child, 'SIGKILL'), killGraceMs);
    };

    unregisterSignals = registerSignalTerminator((signal) => {
      terminate(makeError(`${command} interrupted by ${signal}`, 'INTERRUPTED'));
    });

    const collect = (chunks, kind) => (chunk) => {
      const buffer = Buffer.from(chunk);
      if (kind === 'stdout') stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      if (maxOutputBytes > 0 && (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes)) {
        terminate(makeError(`${kind} exceeded the ${maxOutputBytes}-byte output limit`, 'OUTPUT_LIMIT'));
        return;
      }
      chunks.push(buffer);
    };

    child.stdout.on('data', collect(stdoutChunks, 'stdout'));
    child.stderr.on('data', collect(stderrChunks, 'stderr'));
    child.stdin.on('error', () => {});

    child.once('error', (error) => {
      const message = error?.code === 'ENOENT'
        ? `${command} was not found; install OpenCode and ensure it is on PATH`
        : `Could not start ${command}: ${error?.message || 'spawn failed'}`;
      finish(() => reject(makeError(message, error?.code || 'SPAWN')));
    });

    child.once('close', (code, signal) => {
      finish(() => {
        if (forcedError) {
          reject(forcedError);
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code !== 0) {
          if (isEntitlementUnavailable(stderr) || isEntitlementUnavailable(stdout)) {
            reject(entitlementUnavailableError());
            return;
          }
          const suffix = signal ? ` (signal ${signal})` : '';
          reject(makeError(`${command} exited with code ${code}${suffix}; provider diagnostics suppressed`, 'PROCESS_EXIT'));
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        terminate(makeError(`${command} timed out after ${timeoutMs}ms`, 'TIMEOUT'));
      }, timeoutMs);
    }

    child.stdin.end(prompt, 'utf8');
  });
}

export async function callOpenCode({
  model,
  prompt,
  timeoutMs = 0,
  commandRunner = runBoundedCommand,
  inheritedEnv = process.env,
  cwd = process.cwd(),
  disableServer = inheritedEnv.OCASK_DISABLE_SERVER !== '0',
  serverProvider = ensurePersistentServer,
  serverOptions = {},
  opencodeBin = resolveOnPath('opencode', inheritedEnv.PATH),
  metaSink = null
}) {
  // Resolve once from the original host PATH. The server/client then execute this
  // immutable absolute path while the leaf-shim PATH constrains only their children.
  if (!opencodeBin) {
    throw makeError('OpenCode was not found on the original host PATH', 'ENOENT');
  }
  // The long-lived persistent server executes tool calls for attached requests, so it
  // must launch with a leaf-safe environment (AI_FLOW_LEAF=1 + shim PATH + surface +
  // fresh trace, parent = host trace). Tool subprocesses in the server then cannot
  // recurse into external model runners. Per-request trace metadata, Basic auth,
  // attach reuse, full native tools/network/repo access, and direct-mode behavior are
  // all preserved below.
  const serverEnv = disableServer ? inheritedEnv : leafChildEnv(inheritedEnv, 'opencode');
  let server = null;
  if (!disableServer) {
    try {
      server = await serverProvider({ inheritedEnv: serverEnv, opencodeBin, ...serverOptions });
    } catch {
      // Establishment happens before prompt submission, so direct launch is safe.
      server = null;
    }
  }

  const isDeepSeek = modelFamily(model) === 'deepseek';
  const providerPrefix = isDeepSeek ? 'deepseek' : 'opencode-go';
  const args = server
    ? [
        'run',
        '--attach',
        server.url,
        '--dir',
        cwd,
        '--auto',
        '--pure',
        '--model',
        `${providerPrefix}/${model}`,
        '--format',
        'json',
        ...(isDeepSeek ? ['--variant', 'max'] : [])
      ]
    : [
        'run', '--auto', '--pure', '--model', `${providerPrefix}/${model}`, '--format', 'json',
        ...(isDeepSeek ? ['--variant', 'max'] : [])
      ];
  // Resolve the real opencode to an absolute path from the ORIGINAL PATH, then
  // install the terminal-leaf shim PATH for the child env. The abs-path spawn
  // bypasses the shim PATH, which only constrains the model child's subprocesses.
  const env = leafChildEnv({
    ...inheritedEnv,
    ...CHILD_ENV,
    ...(server ? { OPENCODE_SERVER_PASSWORD: server.password } : {})
  }, 'opencode');

  let result;
  try {
    result = await commandRunner({
      command: opencodeBin,
      args,
      prompt: DELEGATED_IDENTITY_PREFIX + prompt,
      cwd,
      env,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    });
  } catch (error) {
    if (metaSink) {
      metaSink.model = model;
      metaSink.server_mode = server ? 'attached' : 'direct';
      metaSink.server_cold = server ? Boolean(server.cold) : true;
    }
    if (error?.code === 'GO_ENTITLEMENT_UNAVAILABLE' || isEntitlementUnavailable(error?.message)) {
      throw entitlementUnavailableError();
    }
    if (server) {
      throw makeError(
        `Attached OpenCode request failed after model submission may have begun: ${error?.message || 'client failure'}`,
        'ATTACH_REQUEST_FAILURE'
      );
    }
    throw error;
  }
  if (isEntitlementUnavailable(result.stderr)) throw entitlementUnavailableError();
  if (metaSink) {
    metaSink.model = model;
    metaSink.server_mode = server ? 'attached' : 'direct';
    metaSink.server_cold = server ? Boolean(server.cold) : true;
    metaSink.output_bytes = Buffer.byteLength(result.stdout || '', 'utf8');
  }
  return parseOpenCodeJsonl(result.stdout);
}

function retryCorrection(error) {
  const reason = reasonCodeFor(error);
  return `## RETRY CORRECTION\nThe prior attempt failed with reason code: ${reason}. Follow the response contract exactly. Do not repeat the invalid response.`;
}

function isFallbackEligible(error) {
  return new Set([
    'MODEL_OUTPUT'
  ]).has(error?.code);
}

export async function runAsk({
  model,
  taskText,
  systemText = '',
  contextText = '',
  jsonMode = false,
  requireVerdict = false,
  noFallback = false,
  lens = 'general',
  temperature = 0,
  maxTokens,
  timeoutMs = 0,
  fallbackModel,
  commandRunner = runBoundedCommand,
  inheritedEnv = process.env,
  cwd = process.cwd(),
  disableServer = inheritedEnv.OCASK_DISABLE_SERVER !== '0',
  serverProvider = ensurePersistentServer,
  serverOptions = {},
  opencodeBin = resolveOnPath('opencode', inheritedEnv.PATH)
}) {
  parseTemperature(String(temperature));
  guardAllowedModels({ model, fallbackModel });
  // --no-fallback disables the opposite-family fallback entirely (exact-model mode).
  // Automatic replay is safe only for the explicit review contract, which is
  // read-only. A fallback explicitly named for another task is the caller's
  // assertion that replay is acceptable. Uncertain transport failures never replay.
  const selectedFallback = noFallback
    ? null
    : (fallbackModel || (requireVerdict ? defaultFallbackModel(model) : null));
  if (selectedFallback) guardAllowedModels({ model, fallbackModel: selectedFallback });

  const originalPrompt = buildPrompt({
    taskText,
    systemText,
    contextText,
    jsonMode,
    requireVerdict,
    maxTokens,
    lens
  });
  const options = { jsonMode, requireVerdict };
  const inputBytes = Buffer.byteLength(originalPrompt, 'utf8');
  const trace = inheritedEnv.AI_FLOW_TRACE || randomBytes(16).toString('hex');
  const runStarted = Date.now();
  const metadata = {
    requested_model: model,
    actual_model: null,
    no_fallback: Boolean(noFallback),
    input_bytes: inputBytes,
    output_bytes: null,
    attempts: [],
    exit_code: null,
    fallback_used: false
  };
  emitTelemetry({ surface: 'opencode', role: modelFamily(model) || 'deepseek', event: 'start',
    phase: requireVerdict ? 'review' : 'leaf', trace, model, input_bytes: inputBytes });

  const timeAttempt = async (askModel, prompt) => {
    const t0 = Date.now();
    const sink = {};
    try {
      const raw = await callOpenCode({
      model: askModel, prompt, timeoutMs, commandRunner, inheritedEnv, cwd,
        disableServer, serverProvider, serverOptions, opencodeBin, metaSink: sink
      });
      const out = validateAssistantOutput(raw, options);
      const usableBytes = Buffer.byteLength(
        typeof out === 'string' ? out : JSON.stringify(out),
        'utf8'
      );
      metadata.attempts.push({
        model: askModel, duration_ms: Date.now() - t0, outcome: 'success',
        reason_code: 'ok', fallback: askModel !== model,
        server_mode: sink.server_mode || null, server_cold: sink.server_cold ?? null,
        output_bytes: usableBytes
      });
      metadata.output_bytes = usableBytes;
      return out;
    } catch (error) {
      error.ocaskAttempt = {
        model: askModel, duration_ms: Date.now() - t0, outcome: 'failed',
        reason_code: reasonCodeFor(error), fallback: askModel !== model,
        server_mode: sink.server_mode || null, server_cold: sink.server_cold ?? null,
        output_bytes: null
      };
      throw error;
    }
  };

  let result;
  try {
    const out = await timeAttempt(model, originalPrompt);
    result = { ok: true, output: out, model };
    metadata.actual_model = model;
  } catch (primaryError) {
    metadata.attempts.push(primaryError.ocaskAttempt || {
      model, duration_ms: Date.now() - runStarted, outcome: 'failed',
      reason_code: reasonCodeFor(primaryError), fallback: false,
      server_mode: null, server_cold: null, output_bytes: null
    });
    metadata.actual_model = model;
    if (!selectedFallback || !isFallbackEligible(primaryError)) {
      metadata.exit_code = 1;
      metadata.duration_ms = Date.now() - runStarted;
      emitTelemetry({ surface: 'opencode', role: modelFamily(model) || 'deepseek', event: 'end',
        phase: requireVerdict ? 'review' : 'leaf', trace, model, input_bytes: inputBytes,
        duration_ms: metadata.duration_ms, exit_code: 1, reason_code: reasonCodeFor(primaryError) });
      const err = primaryError;
      err.ocaskMetadata = metadata;
      throw err;
    }
    // One opposite-family fallback (default reliability path; never in --no-fallback).
    try {
      const fbOut = await timeAttempt(selectedFallback, `${originalPrompt}\n\n${retryCorrection(primaryError)}`);
      result = { ok: true, output: fbOut, model: selectedFallback };
      metadata.actual_model = selectedFallback;
      metadata.fallback_used = true;
    } catch (fbError) {
      metadata.attempts.push(fbError.ocaskAttempt || {
        model: selectedFallback, duration_ms: 0, outcome: 'failed',
        reason_code: reasonCodeFor(fbError), fallback: true,
        server_mode: null, server_cold: null, output_bytes: null
      });
      metadata.actual_model = selectedFallback;
      metadata.exit_code = 1;
      metadata.duration_ms = Date.now() - runStarted;
      emitTelemetry({ surface: 'opencode', role: modelFamily(selectedFallback) || 'qwen', event: 'end',
        phase: requireVerdict ? 'review' : 'leaf', trace, model: selectedFallback,
        fallback_from: model, input_bytes: inputBytes, duration_ms: metadata.duration_ms, exit_code: 1,
        reason_code: reasonCodeFor(fbError) });
      fbError.ocaskMetadata = metadata;
      throw fbError;
    }
  }
  metadata.exit_code = 0;
  metadata.duration_ms = Date.now() - runStarted;
  emitTelemetry({ surface: 'opencode', role: modelFamily(result.model) || 'deepseek', event: 'end',
    phase: requireVerdict ? 'review' : 'leaf', trace, model: result.model,
    fallback_from: metadata.fallback_used ? model : null,
    input_bytes: inputBytes, output_bytes: metadata.output_bytes,
    duration_ms: metadata.duration_ms, exit_code: 0,
    reason_code: metadata.fallback_used ? 'fallback_used' : 'ok' });
  return { ...result, metadata };
}

function reasonCodeFor(error) {
  const code = error?.code;
  if (code === 'GO_ENTITLEMENT_UNAVAILABLE') return 'entitlement_unavailable';
  if (code === 'MODEL_OUTPUT') return 'malformed_contract';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'OUTPUT_LIMIT') return 'malformed_contract';
  if (code === 'PROCESS_EXIT' || code === 'SPAWN' || code === 'ENOENT') return 'spawn_error';
  if (code === 'ATTACH_REQUEST_FAILURE') return 'provider_error';
  return code ? 'provider_error' : 'unknown';
}

async function readStdin(stdin = process.stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function shouldTryAsPath(source) {
  return !source.includes('\n') && !source.includes('\r') && Buffer.byteLength(source) <= MAX_PLAUSIBLE_PATH_LENGTH;
}

export async function readExistingPathOrLiteral(source, stdin = process.stdin) {
  if (source === '-') return readStdin(stdin);
  if (!shouldTryAsPath(source)) return source;

  try {
    const stat = await fs.stat(source);
    if (stat.isFile()) return fs.readFile(source, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENAMETOOLONG') throw error;
  }
  return source;
}

export async function runMain(
  argv = process.argv.slice(2),
  commandRunner = runBoundedCommand,
  writeStdout = console.log,
  writeStderr = console.error,
  stdin = process.stdin,
  cwd = process.cwd(),
  runtimeOptions = {}
) {
  let args = null;
  try {
    args = parseArgs(argv);
    if (!args.model || !args.task) throw new Error(USAGE);

    const stdinSources = ['task', 'system', 'context'].filter((key) => args[key] === '-');
    if (stdinSources.length > 1) {
      throw new Error('Only one of --task, --system, and --context may read from stdin');
    }

    const temperature = parseTemperature(args.temperature);
    const maxTokens = parsePositiveInt(args['max-tokens'], '--max-tokens', undefined);
    const timeoutMs = parsePositiveInt(args['timeout-ms'], '--timeout-ms', 0);
    const noFallback = args['no-fallback'] === true;
    if (noFallback && args['fallback-model']) {
      throw new Error('--no-fallback cannot be combined with --fallback-model');
    }
    guardAllowedModels({ model: args.model, fallbackModel: args['fallback-model'] });

    const rawLens = args.lens || 'general';
    const lens = rawLens === 'general' ? 'general' : VALID_LENSES.includes(rawLens) ? rawLens : (() => { throw new Error(`--lens must be one of: ${VALID_LENSES.join(', ')}`); })();
    if (lens !== 'general' && args['require-verdict'] !== true) {
      throw new Error('--lens requires --require-verdict (lens frameworks are designed for review/audit tasks)');
    }

    const [taskText, systemText, contextText] = await Promise.all([
      readExistingPathOrLiteral(args.task, stdin),
      args.system ? readExistingPathOrLiteral(args.system, stdin) : Promise.resolve(''),
      args.context ? readExistingPathOrLiteral(args.context, stdin) : Promise.resolve('')
    ]);

    const result = await runAsk({
      model: args.model,
      taskText,
      systemText,
      contextText,
      jsonMode: args.json === true,
      requireVerdict: args['require-verdict'] === true,
      noFallback,
      lens,
      temperature,
      maxTokens,
      timeoutMs,
      fallbackModel: args['fallback-model'],
      commandRunner,
      cwd,
      ...runtimeOptions
    });
    // Privacy-safe attempt metadata: model/attempts/duration/reason/fallback/server/
    // exit only. Never prompt/output/source/env/argv/provider text.
    if (args.metadata) await writeAtomicPrivate(args.metadata, JSON.stringify(result.metadata || {}) + '\n');
    writeStdout(args.json ? JSON.stringify(result.output) : result.output);
  } catch (error) {
    const cause = error?.message || 'delegation failed';
    writeStderr(`ocask error: ${cause}`);
    if (argv.includes('--json')) writeStdout(JSON.stringify({ error: cause }));
    if (args && args.metadata && error?.ocaskMetadata) {
      await writeAtomicPrivate(args.metadata, JSON.stringify(error.ocaskMetadata) + '\n').catch(() => {});
    }
    process.exitCode = 1;
  }
}

// Atomic mode-0600 write (no symlink follow) for the private metadata report.
async function writeAtomicPrivate(target, text) {
  const parsed = path.resolve(target);
  const dir = path.dirname(parsed);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(parsed)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await fs.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, parsed);
  await fs.chmod(parsed, 0o600);
}

async function main() {
  await runMain();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
