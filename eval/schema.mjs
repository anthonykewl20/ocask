// SPDX-License-Identifier: Apache-2.0
// Case record schema validation for offline evaluation corpus entries.

const VALID_GROUND_TRUTH = Object.freeze(['buggy', 'clean']);
const VALID_EXPECTED_VERDICTS = Object.freeze(['APPROVED', 'WARNING', 'BLOCKED']);

function requireString(value, name, errors) {
  if (typeof value !== 'string') {
    errors.push(`${name} must be a string`);
    return false;
  }
  if (!value.trim()) {
    errors.push(`${name} must be non-empty`);
    return false;
  }
  return true;
}

export function validateCase(caseRecord) {
  const errors = [];

  if (caseRecord == null || typeof caseRecord !== 'object' || Array.isArray(caseRecord)) {
    return { ok: false, errors: ['Case record must be an object'] };
  }

  requireString(caseRecord.language, 'language', errors);
  requireString(caseRecord.diff, 'diff', errors);
  requireString(caseRecord.spec, 'spec', errors);

  const gt = caseRecord.ground_truth;
  if (gt !== 'buggy' && gt !== 'clean') {
    errors.push('ground_truth must be one of: buggy, clean');
  }

  const expected = typeof caseRecord.expected === 'string'
    ? caseRecord.expected.trim().toUpperCase()
    : '';
  if (!VALID_EXPECTED_VERDICTS.includes(expected)) {
    errors.push('expected must be one of: APPROVED, WARNING, BLOCKED');
  }

  return { ok: errors.length === 0, errors };
}

export const schema = Object.freeze({
  required: ['language', 'diff', 'spec', 'ground_truth', 'expected'],
  groundTruth: [...VALID_GROUND_TRUTH],
  expected: [...VALID_EXPECTED_VERDICTS],
});
