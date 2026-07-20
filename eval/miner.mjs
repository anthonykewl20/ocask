#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Reverse-of-fix case mining utilities.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCase } from './schema.mjs';

const DEFAULT_EXPECTED = 'BLOCKED';
const CLI_DOC = `Usage:
  node eval/miner.mjs --source-json '<json>' --input <fixes.json> [--output <cases.json>]

Inputs are expected to be explicit mined artifacts only:
  - source.repo or source.repo_ref (explicit repository reference)
  - source.cutoff or source.postTrainingCutoff or source.private=true (explicit sourcing constraint)

The source and fix commit metadata are not inferred from public history.
`;

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(message);
  }
}

function requireString(value, field, message) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} ${message}`);
  }
}

function requireNonEmptyArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`);
  }
}

function normalizeText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeValue(value, fallback = 'UNKNOWN') {
  return value == null ? fallback : String(value);
}

function normalizeSource(source) {
  return {
    repo: normalizeText(source?.repo, source?.repo_ref),
    ref: normalizeText(source?.repo_ref, source?.ref),
    cutoff: normalizeText(source?.postTrainingCutoff, source?.cutoff),
    private: Boolean(source?.private),
  };
}

function assertSourceSource(source) {
  const repo = normalizeText(source?.repo, source?.repo_ref);
  if (!repo) {
    throw new Error('Reverse-of-fix mining requires an explicit source repo reference');
  }
  if (!source?.cutoff && !source?.postTrainingCutoff && !source?.private) {
    throw new Error('Reverse-of-fix mining requires an explicit post-training-cutoff or private constraint');
  }
}

const CLEAN_HINTS = [
  'refactor',
  'cleanup',
  'chore',
  'rename',
  'format',
  'reformat',
  'no-op',
];

function hasRefactorHint(value) {
  const normalized = normalizeText(value).toLowerCase();
  return CLEAN_HINTS.some((hint) => normalized.includes(hint));
}

function commitGroundTruth(commit) {
  const declared = normalizeText(commit?.ground_truth);
  if (declared === 'clean' || declared === 'buggy') return declared;

  if (commit?.isRefactor === true || commit?.refactor === true || commit?.is_cleanup === true) {
    return 'clean';
  }

  if (hasRefactorHint(commit?.type) || hasRefactorHint(commit?.classification) || hasRefactorHint(commit?.message)) {
    return 'clean';
  }

  if (Array.isArray(commit?.labels) && commit.labels.some((label) => hasRefactorHint(String(label)))) {
    return 'clean';
  }

  return 'buggy';
}

function isHunkHeader(line) {
  return typeof line === 'string' && line.startsWith('@@');
}

function reverseHunkHeader(line) {
  if (typeof line !== 'string') return line;
  const match = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
  if (!match) return line;

  const oldStart = Number(match[1]);
  const oldCount = Number(match[2] ?? 1);
  const newStart = Number(match[3]);
  const newCount = Number(match[4] ?? 1);
  const trailer = match[5] || '';
  return `@@ -${newStart},${newCount} +${oldStart},${oldCount} @@${trailer}`;
}

function normalizePatchLineBreaks(patchText) {
  return String(patchText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function reverseUnifiedDiff(patchText) {
  return normalizePatchText(patchText)
    .split('\n')
    .map((line) => {
      if (isHunkHeader(line)) {
        return reverseHunkHeader(line);
      }
      if (typeof line === 'string' && line.startsWith('--- ')) return line;
      if (typeof line === 'string' && line.startsWith('+++ ')) return line;
      if (typeof line === 'string' && line.startsWith('\\ No newline at end of file')) return line;
      if (line.startsWith('+')) return `-${line.slice(1)}`;
      if (line.startsWith('-')) return `+${line.slice(1)}`;
      return line;
    })
    .join('\n');
}

function normalizePatchText(patchText) {
  const normalized = normalizePatchLineBreaks(patchText);
  if (!normalized.includes('\n')) {
    return `${normalized}\n`;
  }
  return normalized;
}

function extractGroundTruthLinesFromReversedDiff(patchText) {
  return normalizePatchText(patchText)
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++ '))
    .map((line) => line.slice(1));
}

function buildSourceReference(source, commit) {
  return {
    ...source,
    commit: normalizeValue(commit?.commit),
    source_ref: normalizeValue(commit?.source_ref, source.ref),
    source_commit: normalizeValue(commit?.source_commit, source.commit),
  };
}

export function reverseFixPatch(fixCommit, { source }) {
  requireObject(fixCommit, 'reverseFixPatch requires a commit object');
  requireString(fixCommit.diff, 'diff', 'must be a non-empty unified diff string.');
  requireObject(source, 'reverseFixPatch requires a source descriptor');
  assertSourceSource(source);

  const groundTruth = commitGroundTruth(fixCommit);
  const fixedDiff = String(fixCommit.diff);
  const diff = groundTruth === 'clean' ? fixedDiff : reverseUnifiedDiff(fixedDiff);
  const caseIdSafeCommit = normalizeValue(fixCommit.commit, `${fixCommit.sha ?? fixCommit.id ?? Date.now()}`);
  const repo = normalizeValue(source.repo, source.repo_ref);
  const isForward = groundTruth === 'clean';
  const caseIdPrefix = isForward ? 'forward' : 'reverse';
  const changedLines = groundTruth === 'clean' ? [] : extractGroundTruthLinesFromReversedDiff(diff);

  const record = {
    language: 'javascript',
    diff,
    spec: normalizeText(
      fixCommit.message,
      normalizeText(fixCommit.title, 'Unknown source fix commit'),
    ),
    ground_truth: groundTruth,
    expected: groundTruth === 'clean' ? 'APPROVED' : DEFAULT_EXPECTED,
    source: buildSourceReference(source, fixCommit),
    case_id: `reverse:${caseIdPrefix}:${repo}:${caseIdSafeCommit}`,
    changed_lines: changedLines,
  };

  const { ok, errors } = validateCase(record);
  if (!ok) {
    throw new Error(`Invalid mined case: ${errors.join('; ')}`);
  }

  return record;
}

export function mineReverseFixCases({ source, fixes }) {
  requireObject(source, 'mineReverseFixCases requires a source descriptor');
  assertSourceSource(source);
  requireNonEmptyArray(fixes, 'fixes');

  const normalizedSource = normalizeSource(source);
  const cases = [];

  for (const commit of fixes) {
    try {
      const candidate = reverseFixPatch(commit, { source: normalizedSource });
      cases.push(candidate);
    } catch {
      continue;
    }
  }

  return cases;
}

function parseJsonInput(raw) {
  const payload = JSON.parse(raw);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.fixes)) return payload.fixes;
  throw new Error('Invalid fixes payload: expected an array or { fixes: [...] }');
}

function parseSourceArg(value) {
  const source = typeof value === 'string' ? JSON.parse(value) : value;
  requireObject(source, '--source-json must be a JSON object');
  return normalizeSource(source);
}

function parseArgs(argv) {
  const out = { };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      return out;
    }

    if (arg === '--source-json' && argv[i + 1]) {
      out.source = parseSourceArg(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === '--input' && argv[i + 1]) {
      out.inputPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--output' && argv[i + 1]) {
      out.outputPath = argv[i + 1];
      i += 1;
      continue;
    }

    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  if (!out.source || !out.inputPath) {
    out.help = true;
    out.parseError = true;
    out.errorMessage = 'Missing required --source-json and --input arguments.';
  }
  return out;
}

export async function runMinerCLI({
  source,
  inputPath,
  outputPath,
} = {}) {
  if (!inputPath) throw new Error('Missing --input path');

  const fixes = parseJsonInput(await fs.readFile(inputPath, 'utf8'));
  const sourceRecord = normalizeSource(source);
  assertSourceSource(sourceRecord);
  const cases = mineReverseFixCases({ source: sourceRecord, fixes });

  const payload = JSON.stringify(cases, null, 2) + '\n';
  if (outputPath) {
    const absolute = path.resolve(outputPath);
    await fs.writeFile(absolute, payload, 'utf8');
    return { path: absolute, count: cases.length };
  }

  return { output: payload, count: cases.length };
}

export function describeSourceConstraint(source) {
  return {
    repo: source?.repo || source?.repo_ref || 'unknown',
    ref: source?.repo_ref || source?.ref || null,
    private: Boolean(source?.private),
    postTrainingCutoff: source?.postTrainingCutoff || source?.cutoff || null,
    notes: source?.notes || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(CLI_DOC);
    if (args.parseError && args.errorMessage) {
      console.error(args.errorMessage);
      process.exitCode = 1;
    }
    return;
  }

  const { source, inputPath, outputPath } = args;
  const result = await runMinerCLI({
    source,
    inputPath,
    outputPath,
  });

  if (outputPath) {
    console.log(`${result.count} cases written to ${result.path}`);
  } else {
    process.stdout.write(result.output);
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
