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

// Curated identity-trust table. Every entry is a HUMAN-ASSERTED DECLARATION,
// never a cryptographic verification. The table is the sole authority for which
// transports may carry an identity pin and for the exact route those transports
// execute. A non-null snapshotId is itself the wire model ID and supersedes the
// mutable modelRoute alias; null means that transport exposes no usable snapshot.
const IDENTITY_TRANSPORT_TRUST = Object.freeze({
  'deepseek-v4-pro': Object.freeze([
    Object.freeze({
      provider: 'deepseek',
      modelRoute: 'deepseek-chat',
      snapshotId: null,
      equivalence: 'declared',
      snapshotStatus: 'vendor-exposes-no-snapshot',
      declaration: 'Human-curated declaration that the direct DeepSeek route serves the deepseek-v4-pro weights.',
      provenance: '.evidence/issue5-nofallback-decision.md',
    }),
    Object.freeze({
      provider: 'opencode',
      modelRoute: 'deepseek/deepseek-v4-pro',
      snapshotId: null,
      equivalence: 'declared',
      snapshotStatus: 'vendor-exposes-no-snapshot',
      declaration: 'Human-curated declaration that the OpenCode route serves the deepseek-v4-pro weights.',
      provenance: '.evidence/issue5-nofallback-decision.md',
    }),
  ]),
  'qwen3.7-plus': Object.freeze([
    Object.freeze({
      provider: 'qwen',
      modelRoute: 'qwen-plus',
      snapshotId: null,
      equivalence: 'declared',
      snapshotStatus: 'vendor-exposes-no-snapshot',
      declaration: 'Human-curated declaration that the native Qwen route serves the qwen3.7-plus weights.',
      provenance: '.evidence/issue5-nofallback-decision.md',
    }),
    Object.freeze({
      provider: 'opencode',
      modelRoute: 'alibaba/qwen3.7-plus',
      snapshotId: null,
      equivalence: 'declared',
      snapshotStatus: 'vendor-exposes-no-snapshot',
      declaration: 'Human-curated declaration that the OpenCode route serves the qwen3.7-plus weights.',
      provenance: '.evidence/issue5-nofallback-decision.md',
    }),
  ]),
});

export function identityTransportTrustTable() {
  return IDENTITY_TRANSPORT_TRUST;
}

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

function uniqueProviders(values) {
  return [...new Set(values)];
}

export function providerSupportsModel(provider, model) {
  const family = modelFamily(model);
  if (provider === 'opencode') return family === 'deepseek' || family === 'qwen';
  if (provider === 'deepseek') return family === 'deepseek';
  if (provider === 'qwen') return family === 'qwen';
  return false;
}

export function identityTransportsForModel(model) {
  return [...(IDENTITY_TRANSPORT_TRUST[model] || [])];
}

export function identityTransportForModel(model, provider) {
  return IDENTITY_TRANSPORT_TRUST[model]?.find(entry => entry.provider === provider) || null;
}

export function isIdentityPreservingTransport(model, provider) {
  return identityTransportForModel(model, provider)?.equivalence === 'declared';
}

// Provider modules call this for table-backed models, eliminating route drift.
// snapshotId is deliberately executable: adding a non-null pin changes the wire
// route without requiring a second edit in the provider implementation.
export function identityTransportRoute(model, provider) {
  const entry = identityTransportForModel(model, provider);
  return entry ? (entry.snapshotId || entry.modelRoute) : null;
}

function identityTransportProviders(model) {
  return identityTransportsForModel(model)
    .filter(entry => entry.equivalence === 'declared')
    .map(entry => entry.provider);
}

export function resolveProviderChain({ model, preferredProvider = null, noFallback = false, chain = null }) {
  const primary = preferredProvider || defaultProvider(model);
  const configuredChain = chain?.[primary];
  let providers;

  // --provider pins the wire and therefore takes precedence over configuration.
  if (preferredProvider) {
    providers = [preferredProvider];
  } else if (configuredChain && Array.isArray(configuredChain)) {
    providers = configuredChain;
  } else if (noFallback) {
    providers = identityTransportProviders(model);
  } else {
    providers = DEFAULT_FALLBACK_CHAIN[primary] || [primary];
  }

  // FINAL, unconditional gates. No preferred provider or configured chain can
  // bypass serving compatibility; an identity pin additionally admits only the
  // explicitly declared transports in the trust table.
  let filtered = uniqueProviders(providers);
  if (noFallback) filtered = filtered.filter(provider => isIdentityPreservingTransport(model, provider));
  filtered = filtered.filter(provider => providerSupportsModel(provider, model));

  if (preferredProvider && !providerSupportsModel(preferredProvider, model)) {
    throw Object.assign(
      new ProviderError(`Provider ${preferredProvider} does not serve model ${model}`, 'MODEL_NOT_FOUND'),
      { provider: preferredProvider },
    );
  }
  if (preferredProvider && noFallback && !isIdentityPreservingTransport(model, preferredProvider)) {
    throw Object.assign(
      new ProviderError(`Provider ${preferredProvider} is not a declared identity transport for ${model}`, 'MODEL_NOT_FOUND'),
      { provider: preferredProvider },
    );
  }
  return filtered;
}

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
  const providers = resolveProviderChain({ model, preferredProvider, noFallback, chain });
  const fallbackProviders = providers;

  if (!fallbackProviders.length) {
    throw new ProviderError(`No declared serving providers available for ${model}`, 'NO_PROVIDER');
  }

  let lastError = null;
  const attempts = [];

  for (const providerId of fallbackProviders) {
    let invoke;
    try {
      invoke = await _loadProvider(providerId);
    } catch (err) {
      const e = Object.assign(new ProviderError(`Provider ${providerId} unavailable: ${err.message}`, 'PROVIDER_UNAVAILABLE'), { provider: providerId });
      attempts.push({ provider: providerId, duration_ms: 0, outcome: 'skipped', reason_code: 'PROVIDER_UNAVAILABLE' });
      lastError = e;
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
      error.provider = error.provider || providerId;
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
