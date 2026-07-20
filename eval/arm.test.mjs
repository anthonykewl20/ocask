// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';

import { runOcaskArm, ARM_CONFIG, validateControlLensAgreement } from './arm.mjs';
import { aggregate } from './metrics.mjs';

const CASE = {
  case_id: 'case-arm-1',
  language: 'javascript',
  diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new',
  spec: 'Sanity arm seam check with a realistic reviewer request.',
  ground_truth: 'buggy',
  expected: 'BLOCKED',
};

test('runOcaskArm runs one case through a fake invoke and parses verdict for lenient recall', async () => {
  const invoke = async (request) => {
    assert.equal(request.temperature, 0);
    return {
    output: 'VERDICT: WARNING\nPotentially risky input handling detected.',
    metadata: { attempts: [{ tokensUsed: 123 }] },
    request,
    };
  };

  const row = await runOcaskArm(CASE, 'control', {
    invoke,
    caseIndex: 0,
    iteration: 1,
  });

  assert.equal(row.case_id, CASE.case_id);
  assert.equal(row.arm, 'control');
  assert.equal(row.iteration, 1);
  assert.equal(row.verdict, 'WARNING');
  assert.equal(row.parse_ok, true);
  assert.equal(row.truncated, false);
  assert.equal(row.comparable, true);
  assert.equal(row.model, ARM_CONFIG.control.model);
  assert.equal(row.lens, ARM_CONFIG.control.lens);
  assert.equal(row.tokens_used, 123);
});

test('panel arm config is explicitly cross-family and family-labeled', () => {
  const { panel_members: panelMembers } = ARM_CONFIG.panel;
  assert.equal(Array.isArray(panelMembers), true);
  assert.equal(panelMembers.length >= 2, true);

  const families = panelMembers.map((member) => member?.family).filter(Boolean);
  const uniqueFamilies = [...new Set(families)];
  assert.equal(uniqueFamilies.length, families.length);
  assert.equal(uniqueFamilies.length >= 2, true);
});

test('runOcaskArm normalizes panel members and captures pre-consensus outputs', async () => {
  const blockedOutput = `VERDICT: BLOCKED\n${'B'.repeat(250)}`;
  const approvedOutput = `VERDICT: APPROVED\n${'A'.repeat(250)}`;
  const invoke = async () => ({
    output: 'PANEL NO-JUDGMENT',
    panel_members: [
      {
        model: 'deepseek-v4-pro',
        family: 'deepseek',
        output: blockedOutput,
        output_preview: 'VERDICT: BLOCKED ...',
      },
      {
        model: 'qwen3.7-plus',
        family: 'qwen',
        output: approvedOutput,
        output_preview: 'VERDICT: APPROVED ...',
      },
    ],
    metadata: { attempts: [{ tokensUsed: 200 }, { tokensUsed: 130 }] },
  });

  const row = await runOcaskArm(CASE, 'panel', {
    invoke,
    case_id: 'case-arm-2',
    iteration: 1,
  });

  assert.equal(row.parse_ok, false);
  assert.equal(row.verdict, null);
  assert.equal(Array.isArray(row.panel_members), true);
  assert.equal(row.panel_members.length, 2);
  assert.equal(row.panel_members[0].model, 'deepseek-v4-pro');
  assert.equal(row.panel_members[0].raw, blockedOutput);
  assert.equal(row.panel_members[0].verdict, 'BLOCKED');
  assert.equal(row.panel_members[1].verdict, 'APPROVED');
});

test('runOcaskArm feeds a hand-written case into aggregate for lenient recall', async () => {
  const invoke = async () => ({ output: 'VERDICT: WARNING\nPotential issue with array boundaries.' });

  const row = await runOcaskArm(CASE, 'control', {
    invoke,
    iteration: 1,
  });

  const summary = aggregate([row]);
  assert.equal(summary.by_case[CASE.case_id].control.length, 1);
  assert.equal(summary.by_arm.control.lenient_recall, 1);
});

test('control and lens arms are pinned to the same model in this harness', () => {
  validateControlLensAgreement();
  assert.equal(ARM_CONFIG.control.model, ARM_CONFIG.lens.model);
});
