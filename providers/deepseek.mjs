// Native DeepSeek API provider — direct HTTP to api.deepseek.com.
// OpenAI-compatible chat completions endpoint.
// Auth: DEEPSEEK_API_KEY env var, or $HOME/.deepseek-key where HOME comes from the
// caller-supplied env (#81) — never the process home.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProviderError, identityTransportRoute, isDeepSeekModel } from './factory.mjs';

const BASE_URL = 'https://api.deepseek.com';
const CHAT_ENDPOINT = '/v1/chat/completions';
const DEFAULT_MAX_TOKENS = 65536;

// Read API key: env var takes priority, then key file.
async function resolveApiKey(env = process.env) {
  if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY;
  if (env.HOME) {
    const keyfile = path.join(env.HOME, '.deepseek-key');
    try {
      const key = (await readFile(keyfile, 'utf8')).trim();
      if (key) return key;
    } catch { /* not found */ }
  }
  throw Object.assign(new ProviderError('DEEPSEEK_API_KEY not set and $HOME/.deepseek-key not found (HOME is taken from the caller-supplied environment)', 'AUTH_FAILURE'), { code: 'AUTH_FAILURE' });
}

// Map ocask model IDs to DeepSeek API model IDs.
const MODEL_MAP = {
  'deepseek-v4-flash': 'deepseek-chat',
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-reasoner',
};

function apiModel(model) {
  return identityTransportRoute(model, 'deepseek') || MODEL_MAP[model] || model;
}

function classifyError(status, body) {
  if (status === 401 || status === 403) return 'AUTH_FAILURE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status >= 500) return 'PROVIDER_ERROR';
  if (status === 400 && body?.error?.code === 'invalid_request_error') return 'MALFORMED_RESPONSE';
  return 'PROVIDER_ERROR';
}

function isEntitlementUnavailable(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text || '');
  return /not supported on the lite model list|model_not_supported/i.test(s);
}

export async function invoke({ model, prompt, timeoutMs = 0, env = process.env, cwd = process.cwd() }) {
  if (!isDeepSeekModel(model)) throw Object.assign(new ProviderError(`Not a DeepSeek model: ${model}`, 'MODEL_NOT_FOUND'), { code: 'MODEL_NOT_FOUND' });

  const apiKey = await resolveApiKey(env);
  const apiModelId = apiModel(model);
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(`${BASE_URL}${CHAT_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: apiModelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: DEFAULT_MAX_TOKENS,
        temperature: 0,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw Object.assign(new ProviderError(`DeepSeek API timed out after ${timeoutMs}ms`, 'TIMEOUT'), { code: 'TIMEOUT' });
    }
    throw Object.assign(new ProviderError(`DeepSeek API connection failed: ${error.message}`, 'CONNECTION_ERROR'), { code: 'CONNECTION_ERROR' });
  }

  if (timeout) clearTimeout(timeout);

  let body;
  try {
    body = await response.json();
  } catch {
    const text = await response.text().catch(() => '');
    const code = classifyError(response.status, {});
    const msg = `DeepSeek API returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
    throw Object.assign(new ProviderError(msg, code), { code, status: response.status });
  }

  if (!response.ok) {
    const code = classifyError(response.status, body);
    const msg = body?.error?.message || `DeepSeek API HTTP ${response.status}`;

    if (isEntitlementUnavailable(body) || code === 'MODEL_NOT_FOUND') {
      throw Object.assign(new ProviderError(`DeepSeek model unavailable: ${msg}`, 'ENTITLEMENT_UNAVAILABLE'), { code: 'ENTITLEMENT_UNAVAILABLE', status: response.status });
    }
    if (code === 'RATE_LIMITED') {
      const retryAfter = response.headers.get('retry-after') || 'unknown';
      throw Object.assign(new ProviderError(`DeepSeek rate limited (retry after ${retryAfter}s)`, 'RATE_LIMITED'), { code: 'RATE_LIMITED', retryAfter, status: 429 });
    }
    throw Object.assign(new ProviderError(`DeepSeek API error: ${msg}`, code), { code, status: response.status });
  }

  // Parse response content
  const choice = body?.choices?.[0];
  if (!choice?.message?.content) {
    throw Object.assign(new ProviderError('DeepSeek returned empty response content', 'MALFORMED_RESPONSE'), { code: 'MALFORMED_RESPONSE' });
  }

  const stdout = JSON.stringify([
    { type: 'text', timestamp: Date.now(), part: { type: 'text', text: choice.message.content } },
  ]);

  const usage = body.usage || {};
  const stderr = `[DeepSeek API] tokens: ${usage.prompt_tokens || 0} in / ${usage.completion_tokens || 0} out / ${usage.total_tokens || 0} total`;
  const returnedRoute = typeof body.model === 'string' && body.model ? body.model : apiModelId;
  const modelUsed = returnedRoute === apiModelId ? model : returnedRoute;

  return {
    stdout, stderr, provider: 'deepseek', model_used: modelUsed, model_route: apiModelId,
    tokensUsed: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, total: usage.total_tokens || 0 },
  };
}
