// Provider pricing with dynamic refresh capability.
// Baseline pricing is embedded; --refresh fetches latest from provider APIs/docs.
// Pricing cache lives at ~/.local/share/ocask/pricing-cache.json with 24h TTL.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CACHE_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'ocask'
);
const CACHE_PATH = path.join(CACHE_DIR, 'pricing-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Baseline pricing (USD per million tokens) ──
// Last updated: 2026-07-23. Sources: api.deepseek.com/pricing, openrouter.ai/api/v1/models
const BASELINE_PRICING = {
  'deepseek-v4-pro': {
    input: 0.27, output: 1.10, unit: 'MTok',
    source: 'https://api.deepseek.com/pricing',
    model_family: 'deepseek',
    note: 'DeepSeek V4 Pro (deepseek-chat endpoint)',
  },
  'deepseek-v4-flash': {
    input: 0.14, output: 0.55, unit: 'MTok',
    source: 'https://api.deepseek.com/pricing',
    model_family: 'deepseek',
    note: 'DeepSeek V4 Flash — faster, lighter',
  },
  'deepseek-chat': {
    input: 0.27, output: 1.10, unit: 'MTok',
    source: 'https://api.deepseek.com/pricing',
    model_family: 'deepseek',
    note: 'DeepSeek Chat (maps to V4 Pro)',
  },
  'deepseek-reasoner': {
    input: 0.55, output: 2.19, unit: 'MTok',
    source: 'https://api.deepseek.com/pricing',
    model_family: 'deepseek',
    note: 'DeepSeek Reasoner — includes reasoning tokens in output',
  },
  hy3: {
    input: 0.14, output: 0.58, unit: 'MTok',
    source: 'https://openrouter.ai/api/v1/models',
    model_family: 'hy3',
    note: 'Tencent hy3 — OpenCode route openrouter/tencent/hy3',
  },
};

// ── Cache management ──
async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
}

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    const cache = JSON.parse(raw);
    if (Date.now() - cache.updated_at > CACHE_TTL_MS) return null; // stale
    return cache.pricing;
  } catch {
    return null;
  }
}

async function writeCache(pricing) {
  await ensureCacheDir();
  const data = { updated_at: Date.now(), pricing };
  await fs.writeFile(CACHE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ── Fetch latest pricing ──
async function fetchDeepSeekPricing() {
  try {
    const res = await fetch('https://api.deepseek.com/pricing', { timeout: 5000 });
    if (!res.ok) return null;
    const html = await res.text();
    // Parse pricing from the page. DeepSeek's pricing page is simple key-value.
    // Extract per-model rates using known patterns.
    const pricing = {};
    // DeepSeek v4 Pro
    const v4Match = html.match(/deepseek-chat[^<]*?(\d+\.?\d*)\s*\/\s*1M[^<]*?input[^<]*?(\d+\.?\d*)\s*\/\s*1M[^<]*?output/i);
    if (v4Match) {
      pricing['deepseek-chat'] = { input: parseFloat(v4Match[1]), output: parseFloat(v4Match[2]) };
      pricing['deepseek-v4-pro'] = { input: parseFloat(v4Match[1]), output: parseFloat(v4Match[2]) };
      pricing['deepseek-v4-flash'] = { input: parseFloat(v4Match[1]) * 0.5, output: parseFloat(v4Match[2]) * 0.5 };
    }
    const rMatch = html.match(/deepseek-reasoner[^<]*?(\d+\.?\d*)\s*\/\s*1M[^<]*?input[^<]*?(\d+\.?\d*)\s*\/\s*1M[^<]*?output/i);
    if (rMatch) {
      pricing['deepseek-reasoner'] = { input: parseFloat(rMatch[1]), output: parseFloat(rMatch[2]) };
    }
    return Object.keys(pricing).length > 0 ? pricing : null;
  } catch {
    return null;
  }
}

export async function refreshPricing(force = false) {
  if (!force) {
    const cached = await readCache();
    if (cached) return cached;
  }

  const pricing = { ...BASELINE_PRICING };

  // Attempt to fetch fresh DeepSeek pricing
  const dsPricing = await fetchDeepSeekPricing();
  if (dsPricing) {
    for (const [model, rates] of Object.entries(dsPricing)) {
      if (pricing[model]) {
        pricing[model].input = rates.input;
        pricing[model].output = rates.output;
        pricing[model].refreshed = new Date().toISOString();
      }
    }
  }

  await writeCache(pricing);
  return pricing;
}

export async function getPricing(refresh = false) {
  return refreshPricing(refresh);
}

// ── Cost calculation ──
export function calculateCost(inputTokens, outputTokens, model, pricing) {
  const rate = pricing[model];
  if (!rate) return null;
  const inputCost = (inputTokens / 1_000_000) * rate.input;
  const outputCost = (outputTokens / 1_000_000) * rate.output;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_cost_usd: inputCost,
    output_cost_usd: outputCost,
    total_cost_usd: inputCost + outputCost,
    model,
    rate_input_per_mtok: rate.input,
    rate_output_per_mtok: rate.output,
  };
}

export function formatCost(cost) {
  if (!cost) return 'No cost data available.';
  const t = (n) => n.toFixed(6);
  return [
    `${cost.model}: ${cost.total_tokens.toLocaleString()} tokens`,
    `  Input:  ${cost.input_tokens.toLocaleString()} tokens → $${t(cost.input_cost_usd)}`,
    `  Output: ${cost.output_tokens.toLocaleString()} tokens → $${t(cost.output_cost_usd)}`,
    `  Total:  $${t(cost.total_cost_usd)}`,
  ].join('\n');
}

export function formatPricingTable(pricing) {
  const lines = ['Pricing (USD per million tokens)', '', 'Model               Input    Output   Family   Note'];
  lines.push('─'.repeat(80));
  const sorted = Object.entries(pricing).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [model, rate] of sorted) {
    const refreshed = rate.refreshed ? ' [live]' : '';
    lines.push(`${model.padEnd(22)} $${String(rate.input).padEnd(8)} $${String(rate.output).padEnd(8)} ${rate.model_family.padEnd(9)} ${rate.note || ''}${refreshed}`);
  }
  return lines.join('\n');
}

// ── Cumulative cost from log ──
export async function cumulativeCost(pricing, logEntries) {
  let totalInput = 0, totalOutput = 0;
  const perModel = {};

  for (const entry of logEntries) {
    if (entry.event !== 'attempt.result' || entry.outcome !== 'success') continue;
    if (!entry.tokens_used) continue;
    const model = entry.model;
    if (!model) continue;
    const inputTok = typeof entry.tokens_used === 'object' ? (entry.tokens_used.input || 0) : (entry.tokens_used || 0);
    const outputTok = typeof entry.tokens_used === 'object' ? (entry.tokens_used.output || 0) : 0;
    totalInput += inputTok;
    totalOutput += outputTok;
    if (!perModel[model]) perModel[model] = { input: 0, output: 0 };
    perModel[model].input += inputTok;
    perModel[model].output += outputTok;
  }

  const results = [];
  for (const [model, tokens] of Object.entries(perModel)) {
    const cost = calculateCost(tokens.input, tokens.output, model, pricing);
    if (cost) results.push(cost);
  }

  const grandInputCost = results.reduce((s, c) => s + c.input_cost_usd, 0);
  const grandOutputCost = results.reduce((s, c) => s + c.output_cost_usd, 0);

  return {
    per_model: results,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cost_usd: grandInputCost + grandOutputCost,
  };
}

export function formatCumulativeCost(summary) {
  const t = (n) => n.toFixed(6);
  const lines = [];
  for (const c of summary.per_model) {
    lines.push(`${c.model}: ${c.total_tokens.toLocaleString()} tokens → $${t(c.total_cost_usd)}`);
  }
  lines.push('');
  lines.push(`Total cost: $${t(summary.total_cost_usd)}`);
  lines.push(`Total tokens: ${(summary.total_input_tokens + summary.total_output_tokens).toLocaleString()}`);
  return lines.join('\n');
}
