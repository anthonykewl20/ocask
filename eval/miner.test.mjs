// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { mineReverseFixCases, reverseUnifiedDiff, runMinerCLI, reverseFixPatch } from './miner.mjs';

const FIX_DIFF = `diff --git a/src/loop.js b/src/loop.js
--- a/src/loop.js
+++ b/src/loop.js
@@ -10,1 +10,1 @@
-for (let i = 0; i < n; i += 1) {
+for (let i = 0; i <= n; i += 1) {
    sum += values[i];
}`;

const SOURCE = {
  repo: 'repo/example',
  cutoff: '2025-01-01',
  commit: 'abc',
  private: true,
};

test('reverseUnifiedDiff rewrites hunk headers and swaps +/− lines', () => {
  const reversed = reverseUnifiedDiff(FIX_DIFF);
  const expected = `diff --git a/src/loop.js b/src/loop.js
--- a/src/loop.js
+++ b/src/loop.js
@@ -10,1 +10,1 @@
+for (let i = 0; i < n; i += 1) {
-for (let i = 0; i <= n; i += 1) {
    sum += values[i];
}`;
  assert.equal(reversed.trim(), expected.trim());
});

test('reverse of a clean forward diff stays unchanged for clean commits', () => {
  const commit = {
    message: 'Refactor helper naming and comments only',
    diff: `diff --git a/src/util.js b/src/util.js
--- a/src/util.js
+++ b/src/util.js
@@ -1,1 +1,1 @@
-const raw = format(rawInput);
+const formatted = format(rawInput);
`,
    commit: 'rev-clean',
    ground_truth: 'clean',
    isRefactor: true,
  };

  const record = reverseFixPatch(commit, { source: SOURCE });
  assert.equal(record.ground_truth, 'clean');
  assert.equal(record.expected, 'APPROVED');
  assert.equal(record.changed_lines.length, 0);
});

test('reverse bug commits produce concrete changed-line ground truth', () => {
  const commit = {
    message: 'Fix missing boundary check',
    diff: `diff --git a/src/loop.js b/src/loop.js
--- a/src/loop.js
+++ b/src/loop.js
@@ -8,1 +8,1 @@
-if (index < max) {
+if (index <= max) {
}`,
    commit: 'rev-bug',
  };

  const record = reverseFixPatch(commit, { source: SOURCE });
  assert.equal(record.ground_truth, 'buggy');
  assert.equal(record.expected, 'BLOCKED');
  assert.equal(record.changed_lines.includes('if (index < max) {'), true);
});

test('reverse-unreverse roundtrip maintains structural validity for a simple hunk', () => {
  const reversed = reverseUnifiedDiff(FIX_DIFF);
  const roundTrip = reverseUnifiedDiff(reversed);
  assert.equal(roundTrip.trim(), FIX_DIFF.trim());
});

test('reverseUnifiedDiff rewrites hunk headers with optional counts', () => {
  const patch = `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -5 +6 @@
-return a + b;
+return a - b;`;
  const reversed = reverseUnifiedDiff(patch);
  assert.equal(reversed.includes('@@ -6,1 +5,1 @@'), true);
  const roundTrip = reverseUnifiedDiff(reversed);
  // Omitted hunk counts (`@@ -5 +6 @@`) are normalized to explicit `,1` form on
  // rewrite; the roundtrip is therefore semantically identical, not byte-identical.
  const normalizedPatch = patch.replace('@@ -5 +6 @@', '@@ -5,1 +6,1 @@');
  assert.equal(roundTrip.trim(), normalizedPatch.trim());
});

test('reverse fix mining emits only explicit-source clean/buggy outputs', () => {
  const payload = [
    {
      message: 'Refactor guard condition and comments',
      diff: `diff --git a/src/clean.js b/src/clean.js
--- a/src/clean.js
+++ b/src/clean.js
@@ -1,1 +1,1 @@
-return a < b;
+return a <= b;
`,
      commit: 'clean-1',
      ground_truth: 'clean',
    },
    {
      message: 'Fix loop bound bug',
      diff: FIX_DIFF,
      commit: 'bug-1',
    },
  ];

  const cases = mineReverseFixCases({ source: SOURCE, fixes: payload });

  assert.equal(cases.length, 2);
  assert.equal(cases[0].ground_truth, 'clean');
  assert.equal(cases[1].ground_truth, 'buggy');
});

test('miner CLI writes cases when given explicit source and input file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eval-miner-XXXXXX'));
  const source = {
    repo: 'repo/example',
    postTrainingCutoff: '2025-01-02',
    private: true,
  };

  const inputPath = path.join(dir, 'tmp-miner-input.json');
  const outputPath = path.join(dir, 'tmp-miner-output.json');
  const payload = [
    {
      message: 'Refactor whitespace',
      diff: `diff --git a/src/ui.js b/src/ui.js
--- a/src/ui.js
+++ b/src/ui.js
@@ -1,1 +1,1 @@
-const raw = render();
+const normalizedRender = render();
`,
      commit: 'cli-clean',
      ground_truth: 'clean',
    },
  ];

  await writeFile(inputPath, JSON.stringify(payload), 'utf8');
  try {
    const result = await runMinerCLI({ source, inputPath, outputPath });
    assert.equal(result.count, 1);
    assert.equal(result.path, outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
