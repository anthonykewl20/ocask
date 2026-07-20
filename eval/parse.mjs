// SPDX-License-Identifier: Apache-2.0
// Parse verdict-oriented output from offline/recorded ocask runs.

const VALID_VERDICTS = Object.freeze(['APPROVED', 'WARNING', 'BLOCKED']);
const TRUNCATION_MARKERS = Object.freeze([
  '[truncated]',
  '…[truncated]',
  'output truncated',
]);
const TEXT_FIELDS = Object.freeze(['output', 'raw_output', 'response']);

function normalizeVerdict(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toUpperCase();
  return VALID_VERDICTS.includes(candidate) ? candidate : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function verdictFromText(rawText) {
  if (typeof rawText !== 'string') return null;
  const matched = rawText.match(/VERDICT\s*:\s*(APPROVED|WARNING|BLOCKED)/i);
  return matched ? matched[1].trim().toUpperCase() : null;
}

function verdictFromPayload(payload) {
  if (!isObject(payload)) return null;

  const direct = normalizeVerdict(payload.verdict);
  if (direct) return direct;

  if (typeof payload.output === 'string') {
    const nested = parseJson(payload.output);
    const nestedVerdict = nested ? normalizeVerdict(nested.verdict) : null;
    if (nestedVerdict) return nestedVerdict;

    const outputVerdict = verdictFromText(payload.output);
    if (outputVerdict) return outputVerdict;
  }

  return null;
}

function truncateFlagFromPayload(payload) {
  if (!isObject(payload)) return false;
  return payload.truncated === true
    || payload.truncation === true
    || payload.output_truncated === true
    || payload.mechanism === 'TRUNCATED'
    || payload.mechanism === 'CONTENT_LIMIT'
    || payload.mechanism === 'OUTPUT_LIMIT'
    || payload.subclass === 'truncation'
    || payload.subclass === 'output-limit';
}

function normalizeRaw(rawOutput) {
  if (rawOutput == null) return '';
  if (typeof rawOutput === 'string') return rawOutput;
  if (isObject(rawOutput)) return JSON.stringify(rawOutput);
  return String(rawOutput);
}

function isTruncatedText(rawText) {
  const lower = String(rawText || '').toLowerCase();
  return TRUNCATION_MARKERS.some(marker => lower.includes(marker));
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const cast = Number(value);
    return Number.isFinite(cast) ? cast : null;
  }
  return null;
}

function parseTokensFromAttempts(attempts) {
  if (!Array.isArray(attempts)) return null;
  let total = 0;
  let matched = false;
  for (const attempt of attempts) {
    const value = toNumber(attempt?.tokens_used) ?? toNumber(attempt?.tokensUsed) ?? toNumber(attempt?.token_used);
    if (value === null) continue;
    matched = true;
    total += value;
  }
  return matched ? total : null;
}

function parseTokensFromPayload(payload) {
  if (!isObject(payload)) return null;

  const direct = toNumber(payload.tokens_used)
    ?? toNumber(payload.tokensUsed)
    ?? toNumber(payload.token_used)
    ?? toNumber(payload.tokenUsed);
  if (direct !== null) return direct;

  if (isObject(payload.tokens)) {
    const total = toNumber(payload.tokens.total);
    if (total !== null) return total;
    const input = toNumber(payload.tokens.input);
    const output = toNumber(payload.tokens.output);
    if (input !== null && output !== null) return input + output;
  }

  const metadataAttempts = parseTokensFromAttempts(payload?.metadata?.attempts);
  if (metadataAttempts !== null) return metadataAttempts;

  const attempts = parseTokensFromAttempts(payload?.attempts);
  if (attempts !== null) return attempts;

  return null;
}

function dedupe(values) {
  const out = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function textualCandidates(rawOutput) {
  if (!isObject(rawOutput)) {
    return typeof rawOutput === 'string' ? [rawOutput] : [];
  }

  const candidates = [];
  for (const key of TEXT_FIELDS) {
    if (typeof rawOutput[key] === 'string') {
      candidates.push(rawOutput[key]);
    }
  }
  return candidates;
}

function payloadCandidates(rawOutput) {
  const candidates = [];

  if (isObject(rawOutput)) {
    candidates.push(rawOutput);
  }

  if (typeof rawOutput === 'string') {
    const parsedFromText = parseJson(rawOutput);
    if (parsedFromText !== null) candidates.push(parsedFromText);
  } else if (isObject(rawOutput) && typeof rawOutput.output === 'string') {
    const parsedFromOutput = parseJson(rawOutput.output);
    if (parsedFromOutput !== null) candidates.push(parsedFromOutput);
  }

  return dedupe(candidates);
}

function parseVerdictFromSources(texts, payloads) {
  for (const text of texts) {
    const candidate = verdictFromText(text);
    if (candidate) return candidate;
  }

  for (const payload of payloads) {
    const candidate = verdictFromPayload(payload);
    if (candidate) return candidate;
  }

  return null;
}

function parseTokensFromSources(payloads) {
  for (const payload of payloads) {
    const candidate = parseTokensFromPayload(payload);
    if (candidate !== null) return candidate;
  }
  return null;
}

function parseTruncation(texts, payloads) {
  return texts.some(isTruncatedText) || payloads.some(truncateFlagFromPayload);
}

export function parseVerdict(rawOutput) {
  const raw = normalizeRaw(rawOutput);
  const texts = dedupe(textualCandidates(rawOutput));
  const payloads = dedupe(payloadCandidates(rawOutput));

  return {
    verdict: parseVerdictFromSources(texts, payloads),
    tokens_used: parseTokensFromSources(payloads),
    truncated: parseTruncation(texts, payloads),
    raw,
    parse_ok: parseVerdictFromSources(texts, payloads) !== null,
  };
}
