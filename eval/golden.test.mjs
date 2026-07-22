// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';

import { aggregate } from './metrics.mjs';
import { parseVerdict } from './parse.mjs';

const GOLDEN_FILES = ['approved', 'warning', 'blocked', 'truncated'];

async function loadFixture(name) {
  const file = path.join(new URL('./', import.meta.url).pathname, 'golden', `${name}.json`);
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

test('golden fixtures follow the product verdict contract', async () => {
  const fixtures = await Promise.all(GOLDEN_FILES.map(loadFixture));
  const parsed = fixtures.map((fixture) => {
    const parsedOutput = parseVerdict(fixture.raw_output);
    return {
      case_id: fixture.case_id,
      language: fixture.language,
      arm: fixture.arm,
      iteration: fixture.iteration,
      ground_truth: fixture.ground_truth,
      expected: fixture.expected,
      parse_ok: parsedOutput.parse_ok,
      truncated: parsedOutput.truncated,
      verdict: parsedOutput.verdict,
      raw: parsedOutput.raw,
      tokens_used: parsedOutput.tokens_used,
      comparable: parsedOutput.parse_ok && !parsedOutput.truncated,
      invoke_error: null,
    };
  });

  assert.equal(parsed[0].verdict, 'APPROVED');
  assert.equal(parsed[1].verdict, 'WARNING');
  assert.equal(parsed[2].verdict, 'BLOCKED');
  assert.equal(parsed[3].verdict, null);
  assert.equal(parsed[3].truncated, true);
  assert.equal(parsed[3].parse_ok, false);
  assert.equal(parsed.slice(0, 3).some(row => row.parse_ok === false), false);

  const byCase = aggregate(parsed);
  assert.equal(byCase.row_count, 4);
  assert.equal(Object.keys(byCase.by_arm).length >= 3, true);
  assert.equal(typeof byCase.by_case['gold-blocked-buggy']?.panel?.[0]?.outcome, 'string');
});

test('golden aggregate computes at least baseline recall and flip shape', async () => {
  const fixtures = await Promise.all(GOLDEN_FILES.map(loadFixture));
  const rows = fixtures.map((fixture) => {
    const parsed = parseVerdict(fixture.raw_output);
    return {
      case_id: fixture.case_id,
      language: fixture.language,
      arm: fixture.arm,
      iteration: fixture.iteration,
      ground_truth: fixture.ground_truth,
      expected: fixture.expected,
      parse_ok: parsed.parse_ok,
      truncated: parsed.truncated,
      verdict: parsed.verdict,
      raw: parsed.raw,
      tokens_used: parsed.tokens_used,
      comparable: parsed.parse_ok && !parsed.truncated,
      invoke_error: null,
    };
  });

  const out = aggregate(rows);
  const control = out.by_arm.control;
  assert.equal(typeof control.lenient_recall, 'number');
  assert.equal(typeof control.strict_recall, 'number');
  assert.equal(typeof control.fp_rate, 'number');
  assert.equal(out.flip.total.rate >= 0, true);
  assert.equal(typeof out.guardrails.lens.guardrail_2_tokens_budget, 'boolean');
});
