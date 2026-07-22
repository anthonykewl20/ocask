// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractVerdict } from '../ocask.mjs';
import { parseVerdict } from './parse.mjs';

const CASES = [
  {
    name: 'parses explicit verdict in plain text',
    raw: 'VERDICT: BLOCKED\nNo issue with auth policy.',
    expected: {
      verdict: 'BLOCKED',
      tokens_used: null,
      truncated: false,
      parse_ok: true,
    },
  },
  {
    name: 'parses verdict from JSON object and tokensUsed',
    raw: { verdict: 'WARNING', output: 'VERDICT: WARNING', tokensUsed: 77 },
    expected: {
      verdict: 'WARNING',
      tokens_used: 77,
      truncated: false,
      parse_ok: true,
    },
  },
  {
    name: 'parses verdict from nested output JSON string',
    raw: {
      output: JSON.stringify({ verdict: 'APPROVED', tokens_used: 88 }),
      mechanism: null,
      metadata: { attempts: [{ tokens_used: 22 }, { tokensUsed: 66 }] },
    },
    expected: {
      verdict: 'APPROVED',
      tokens_used: 88,
      truncated: false,
      parse_ok: true,
    },
  },
  {
    name: 'ignores result/summary text when no top-level verdict exists',
    raw: {
      output: 'No verdict produced for this run.',
      summary: 'VERDICT: BLOCKED',
      reason: 'VERDICT: BLOCKED',
      result: 'BLOCKED',
    },
    expected: {
      verdict: null,
      tokens_used: null,
      truncated: false,
      parse_ok: false,
    },
  },
  {
    name: 'detects truncation through marker text',
    raw: 'VERDICT: APPROVED\n...[truncated]',
    expected: {
      verdict: 'APPROVED',
      tokens_used: null,
      truncated: true,
      parse_ok: true,
    },
  },
  {
    name: 'flags miss when output has no parseable verdict',
    raw: { output: 'No explicit verdict line found in output for this run.' },
    expected: {
      verdict: null,
      tokens_used: null,
      truncated: false,
      parse_ok: false,
    },
  },
  {
    name: 'detects truncation from mechanism flag even without marker text',
    raw: { verdict: null, mechanism: 'CONTENT_LIMIT', output: 'Potentially noisy but truncated by token cap.' },
    expected: {
      verdict: null,
      tokens_used: null,
      truncated: true,
      parse_ok: false,
    },
  },
];

for (const fixture of CASES) {
  test(fixture.name, () => {
    const out = parseVerdict(fixture.raw);
    assert.equal(out.verdict, fixture.expected.verdict);
    assert.equal(out.tokens_used, fixture.expected.tokens_used);
    assert.equal(out.truncated, fixture.expected.truncated);
    assert.equal(out.parse_ok, fixture.expected.parse_ok);
    assert.equal(typeof out.raw, 'string');
  });
}

test('prefers parseable payload verdict even when truncated flag is present on companion payload', () => {
  const out = parseVerdict({ verdict: 'WARNING', truncated: true, tokens_used: 12 });
  assert.equal(out.verdict, 'WARNING');
  assert.equal(out.parse_ok, true);
  assert.equal(out.truncated, true);
  assert.equal(out.tokens_used, 12);
});

test('recorded product envelope keeps its authoritative object verdict', () => {
  const raw = { verdict: 'WARNING', output: 'VERDICT: APPROVED' };
  assert.equal(parseVerdict(raw).verdict, extractVerdict(raw));
  assert.equal(parseVerdict(raw).verdict, 'WARNING');
});

test('text verdict parsing agrees with the product parser', async (t) => {
  const corpus = [
    {
      name: 'mid-sentence mention is not a verdict',
      raw: 'The reviewer wrote VERDICT: BLOCKED mid-sentence.',
      expected: null,
    },
    {
      name: 'Markdown-wrapped verdict line is canonicalized',
      raw: '**VERDICT: WARNING**',
      expected: 'WARNING',
    },
    {
      name: 'conflicting verdicts are rejected',
      raw: 'VERDICT: APPROVED\nRationale.\nVERDICT: BLOCKED',
      expected: null,
    },
    {
      name: 'repeated agreeing verdicts resolve once',
      raw: 'VERDICT: BLOCKED\nRationale.\nVERDICT: BLOCKED.',
      expected: 'BLOCKED',
    },
    {
      name: 'verdict below the fifth nonempty line is accepted',
      raw: 'One\nTwo\nThree\nFour\nFive\nRationale.\nVERDICT: APPROVED',
      expected: 'APPROVED',
    },
    {
      name: 'reply without a verdict remains unparseable',
      raw: 'Analysis only; no judgment was supplied.',
      expected: null,
    },
  ];

  for (const fixture of corpus) {
    await t.test(fixture.name, () => {
      const productVerdict = extractVerdict(fixture.raw);
      const harnessVerdict = parseVerdict(fixture.raw).verdict;
      assert.equal(productVerdict, fixture.expected);
      assert.equal(harnessVerdict, productVerdict);
    });
  }
});
