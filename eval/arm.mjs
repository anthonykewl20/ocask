// SPDX-License-Identifier: Apache-2.0
// One ocask invocation seam for offline evaluation.

import { parseVerdict } from './parse.mjs';

const CONTROL_MODEL = 'deepseek-v4-pro';
const LENS_MODEL = 'deepseek-v4-pro';
const CONTROL_LENS = 'general';
const LENS = 'code-review';
const PANEL_LENS = 'general';
const PANEL_MEMBERS = Object.freeze([
  { model: CONTROL_MODEL, family: 'deepseek' },
  { model: 'qwen3.7-plus', family: 'qwen' },
]);

export const ARM_CONFIG = Object.freeze({
  control: Object.freeze({
    model: CONTROL_MODEL,
    lens: CONTROL_LENS,
    panel: false,
  }),
  lens: Object.freeze({
    model: LENS_MODEL,
    lens: LENS,
    panel: false,
  }),
  panel: Object.freeze({
    model: CONTROL_MODEL,
    lens: PANEL_LENS,
    panel: true,
    panel_members: PANEL_MEMBERS,
  }),
});

export const ARM_LABELS = Object.keys(ARM_CONFIG);

function resolveCaseId(caseRecord, index) {
  return String(caseRecord.case_id ?? caseRecord.id ?? index ?? '');
}

function normalizeGroundTruth(groundTruth) {
  if (groundTruth === 'buggy' || groundTruth === 'clean') return groundTruth;
  return null;
}

function normalizeExpected(value) {
  const candidate = String(value || '').toUpperCase();
  return candidate === 'APPROVED' || candidate === 'WARNING' || candidate === 'BLOCKED'
    ? candidate
    : null;
}

function asMemberRows(panelMembers) {
  if (!Array.isArray(panelMembers)) return [];
  return panelMembers.map((member) => {
    const rawPayload = typeof member === 'string'
      ? member
      : (member?.output ?? member?.raw_output ?? member?.response ?? member?.raw ?? member?.output_text);
    const raw = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload ?? null);
    const parsed = parseVerdict(raw);
    return {
      model: member?.model ?? null,
      family: member?.family ?? null,
      raw,
      verdict: parsed.verdict,
      outcome: parsed.parse_ok && !parsed.truncated ? parsed.verdict : 'MISS',
      parse_ok: parsed.parse_ok,
      truncated: parsed.truncated,
      tokens_used: parsed.tokens_used,
    };
  });
}

function normalizeInvokeError(error) {
  if (!error) return null;
  return {
    code: error?.code ?? null,
    message: typeof error.message === 'string' ? error.message : String(error),
  };
}

function pickSource(result) {
  if (!result) return null;
  if (typeof result === 'string' || typeof result === 'number' || result === null) return result;
  if (typeof result === 'object') {
    if (result.output != null) {
      return { ...result, output: String(result.output) };
    }
    if (result.raw_output != null) {
      return { ...result, output: String(result.raw_output) };
    }
    if (result.response != null) {
      return { ...result, output: String(result.response) };
    }
    return result;
  }
  return result;
}

export function runConfigForArm(arm) {
  if (!ARM_CONFIG[arm]) throw new Error(`Unknown arm: ${arm}`);
  return ARM_CONFIG[arm];
}

export function validateControlLensAgreement() {
  if (ARM_CONFIG.control.model !== ARM_CONFIG.lens.model) {
    throw new Error(`control (${ARM_CONFIG.control.model}) and lens (${ARM_CONFIG.lens.model}) models differ`);
  }
}

function buildRequest(caseRecord, arm, config, iteration, case_id, extra) {
  return {
    arm,
    case_id,
    iteration,
    model: config.model,
    lens: config.lens,
    panel: config.panel,
    language: caseRecord.language,
    diff: caseRecord.diff,
    spec: caseRecord.spec,
    ground_truth: caseRecord.ground_truth,
    expected: caseRecord.expected,
    temperature: 0,
    extra,
  };
}

export async function runOcaskArm(caseRecord, arm, {
  invoke,
  iteration = 1,
  case_id,
  caseIndex = null,
  extra = null,
} = {}) {
  if (typeof invoke !== 'function') {
    throw new TypeError('runOcaskArm requires an invoke function');
  }
  if (!ARM_CONFIG[arm]) {
    throw new Error(`Unknown arm: ${arm}`);
  }

  const config = ARM_CONFIG[arm];
  const cid = case_id ?? resolveCaseId(caseRecord, caseIndex);
  const request = buildRequest(caseRecord, arm, config, iteration, cid, extra);

  let result = null;
  let invokeError = null;
  try {
    const rawResult = invoke(request);
    result = rawResult?.then ? await rawResult : rawResult;
  } catch (error) {
    invokeError = normalizeInvokeError(error);
  }

  const source = pickSource(result);
  const parsed = parseVerdict(source);

  const panelMembers = config.panel ? asMemberRows(
    result?.panel_members ?? result?.members ?? result?.panel ?? []
  ) : [];

  return {
    case_id: cid,
    language: caseRecord.language,
    arm,
    iteration,
    ground_truth: normalizeGroundTruth(caseRecord.ground_truth),
    expected: normalizeExpected(caseRecord.expected),
    parse_ok: invokeError ? false : parsed.parse_ok,
    truncated: invokeError ? false : parsed.truncated,
    verdict: invokeError ? null : parsed.verdict,
    raw: invokeError ? '' : parsed.raw,
    tokens_used: invokeError ? null : parsed.tokens_used,
    comparable: !invokeError && parsed.parse_ok && !parsed.truncated,
    model: config.model,
    lens: config.lens,
    panel: config.panel,
    panel_members: panelMembers,
    invoke_error: invokeError,
  };
}
