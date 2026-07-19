// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { validateCase } from './schema.mjs';

const CASES_PATH = path.join(new URL('./', import.meta.url).pathname, 'corpus', 'cases.json');

let corpus;

test('corpus loads and contains 20 cases', async () => {
  const raw = await fs.readFile(CASES_PATH, 'utf8');
  corpus = JSON.parse(raw);
  assert.equal(Array.isArray(corpus), true);
  assert.equal(corpus.length, 20);
});

test('all corpus cases are schema-valid', async () => {
  const raw = await fs.readFile(CASES_PATH, 'utf8');
  const entries = JSON.parse(raw);

  for (const entry of entries) {
    const { ok, errors } = validateCase(entry);
    assert.equal(ok, true, `Invalid case ${entry.case_id}: ${errors?.join(', ')}`);
    assert.equal(typeof entry.spec, 'string');
    assert.equal(typeof entry.diff, 'string');
  }
});

test('corpus is 50/50 buggy/clean', async () => {
  const raw = await fs.readFile(CASES_PATH, 'utf8');
  const entries = JSON.parse(raw);
  const buggy = entries.filter((entry) => entry.ground_truth === 'buggy');
  const clean = entries.filter((entry) => entry.ground_truth === 'clean');
  assert.equal(buggy.length, clean.length);
  assert.equal(buggy.length + clean.length, entries.length);
});
