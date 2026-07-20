// SPDX-License-Identifier: Apache-2.0
// Budget tracker for offline evaluation runs.

// Keep this as the single budget-default source so run-live and matrix runners stay in sync.
export const DEFAULT_BUDGET_CAP = 5000;

function normalizeCap(cap) {
  if (cap === undefined || cap === null) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return Math.floor(cap);
}

export function createBudgetTracker({ cap = DEFAULT_BUDGET_CAP } = {}) {
  const normalizedCap = normalizeCap(cap);
  let used = 0;

  const state = {
    get cap() {
      return normalizedCap;
    },
    get used() {
      return used;
    },
    get remaining() {
      return Number.isFinite(normalizedCap) ? Math.max(0, normalizedCap - used) : Number.POSITIVE_INFINITY;
    },
    get exhausted() {
      return Number.isFinite(normalizedCap) ? used >= normalizedCap : false;
    },
    snapshot() {
      return {
        cap: state.cap,
        used: state.used,
        remaining: state.remaining,
        exhausted: state.exhausted,
      };
    },
    consume(count = 1) {
      const take = Math.max(1, Math.floor(count));
      if (Number.isFinite(normalizedCap) && used + take > normalizedCap) {
        throw new Error('Budget cap exhausted before this invocation');
      }
      used += take;
    },
    reset() {
      used = 0;
    },
  };

  return state;
}

export function hasBudget({ budget, count = 1 }) {
  if (!budget) return false;
  if (Number.isFinite(budget.cap)) return budget.used + count <= budget.cap;
  return true;
}
