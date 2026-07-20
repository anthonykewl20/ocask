#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Offline-only harness entrypoint for live eval wiring.

import path from 'node:path';
import fs from 'node:fs/promises';
import { createBudgetTracker, DEFAULT_BUDGET_CAP } from './budget.mjs';

// Inherit the single harness default from budget.mjs so offline dry runs and live entry gates agree.
export const REFUSAL_MESSAGE = 'Live budget cap already exhausted; refusing to start eval run.';

function budgetFromEnv() {
  const parsed = Number(process.env.EVAL_BUDGET_CAP);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_BUDGET_CAP;
}

function describeEntryGate(env = process.env) {
  return env.RUN_LIVE_EVAL !== 'true'
    ? 'Offline harness is enabled by default. Set RUN_LIVE_EVAL=true to opt into live execution.'
    : null;
}

function assertBudgetAvailable(budget) {
  if (budget.exhausted) {
    throw new Error(REFUSAL_MESSAGE);
  }
}

async function loadCorpus() {
  const corpusPath = path.join(new URL('./', import.meta.url).pathname, 'corpus', 'cases.json');
  const payload = await fs.readFile(corpusPath, 'utf8');
  return JSON.parse(payload);
}

export function makeBudget() {
  return createBudgetTracker({ cap: budgetFromEnv() });
}

export async function runLive({ budget = makeBudget(), env = process.env } = {}) {
  const gateMessage = describeEntryGate(env);
  if (gateMessage) {
    return { status: 'SKIPPED', reason: gateMessage, budget: budget.snapshot() };
  }

  assertBudgetAvailable(budget);

  const corpus = await loadCorpus();
  return {
    status: 'OFFLINE',
    case_count: corpus.length,
    budget: budget.snapshot(),
  };
}

async function main() {
  const env = process.env;
  const gateMessage = describeEntryGate(env);
  if (gateMessage) {
    console.log(gateMessage);
    return;
  }

  const budget = makeBudget();
  const result = await runLive({ budget, env });
  if (result.status === 'OFFLINE') {
    console.log(`RUN_LIVE_EVAL is true. Loaded ${result.case_count} eval cases.`);
    console.log('Live invocation is intentionally disabled in this offline-only phase.');
    console.log(`Budget cap: ${budget.cap}. Refusing any network/model calls in this PR.`);
    return;
  }

  console.log(result.reason);
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
