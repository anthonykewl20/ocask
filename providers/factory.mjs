// Provider factory: resolves a model to a provider, applies fallback chain,
// and delegates invocation. Each provider implements:
//   export async function invoke({ model, prompt, timeoutMs, env, cwd })
//     → { stdout, stderr, provider, model_used }
//   throws ProviderError with .code

// ── ProviderError ──
export class ProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ── Lazy-loaded provider registry (dynamic imports avoid requiring all
//     providers be available before the factory is importable) ──
const _providers = {};
const PROVIDER_IDS = ['opencode', 'deepseek', 'qwen'];

async function _loadProvider(id) {
  if (_providers[id]) return _providers[id];
  switch (id) {
    case 'opencode': _providers.opencode = (await import('./opencode.mjs')).invoke; break;
    case 'deepseek': _providers.deepseek = (await import('./deepseek.mjs')).invoke; break;
    case 'qwen': _providers.qwen = (await import('./qwen.mjs')).invoke; break;
    default: throw new ProviderError(`Unknown provider: ${id}`, 'UNKNOWN_PROVIDER');
  }
  return _providers[id];
}

// ── Model classification ──
const DEEPSEEK_MODELS = new Set([
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner',
]);
const QWEN_MODELS = new Set([
  'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-pro',
]);

export function isDeepSeekModel(model) {
  return DEEPSEEK_MODELS.has(model) || /^deepseek/.test(model);
}

export function isQwenModel(model) {
  return QWEN_MODELS.has(model) || /^qwen/.test(model);
}

export function modelFamily(model) {
  if (isDeepSeekModel(model)) return 'deepseek';
  if (isQwenModel(model)) return 'qwen';
  return null;
}

export function defaultProvider(model) {
  if (isDeepSeekModel(model)) return 'deepseek';
  if (isQwenModel(model)) return 'qwen';
  throw Object.assign(new Error(`Unknown model: ${model}`), { code: 'MODEL_NOT_FOUND' });
}

export function availableProviders() {
  return [...PROVIDER_IDS];
}

// ── Fallback chain config ──
const DEFAULT_FALLBACK_CHAIN = {
  deepseek: ['deepseek', 'qwen', 'opencode'],
  qwen: ['qwen', 'deepseek', 'opencode'],
  opencode: ['opencode', 'deepseek', 'qwen'],
};

const RETRYABLE_CODES = new Set([
  'RATE_LIMITED', 'AUTH_FAILURE', 'TIMEOUT', 'PROVIDER_ERROR',
  'CONNECTION_ERROR', 'MODEL_NOT_FOUND',
]);

// ── Invocation with fallback ──
export async function invokeWithFallback({
  model,
  prompt,
  timeoutMs = 0,
  env = process.env,
  cwd = process.cwd(),
  preferredProvider = null,
  noFallback = false,
  chain = null,
}) {
  const primary = preferredProvider || defaultProvider(model);
  const providers = (chain && chain[primary]) || DEFAULT_FALLBACK_CHAIN[primary] || [primary];
  const fallbackProviders = noFallback ? [primary] : providers;

  let lastError = null;
  const attempts = [];

  for (const providerId of fallbackProviders) {
    let invoke;
    try {
      invoke = await _loadProvider(providerId);
    } catch {
      attempts.push({ provider: providerId, duration_ms: 0, outcome: 'skipped', reason_code: 'UNKNOWN_PROVIDER' });
      continue;
    }

    const started = Date.now();
    try {
      const result = await invoke({ model, prompt, timeoutMs, env, cwd });
      result.provider = providerId;
      result.fallback_used = attempts.length > 0;
      result.attempts = attempts;
      return result;
    } catch (error) {
      const duration = Date.now() - started;
      const code = error?.code || 'UNKNOWN';
      attempts.push({ provider: providerId, duration_ms: duration, outcome: 'failed', reason_code: code });
      lastError = error;

      if (!RETRYABLE_CODES.has(code)) break;
    }
  }

  if (lastError) {
    throw Object.assign(
      new ProviderError(`All providers exhausted (${attempts.map(a => a.provider).join(', ')}); last: ${lastError.message}`, 'ALL_PROVIDERS_EXHAUSTED'),
      { attempts, cause: lastError }
    );
  }
  throw new ProviderError('No providers available', 'NO_PROVIDER');
}
