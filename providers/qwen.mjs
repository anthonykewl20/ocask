// Native Qwen (Alibaba DashScope) API provider.
// OpenAI-compatible endpoint: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
// Auth: QWEN_API_KEY env var or ~/.qwen-key file.
// Supports both Token Plan and Pay-As-You-Go billing.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProviderError, identityTransportRoute, isQwenModel } from './factory.mjs';

const BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const CHAT_ENDPOINT = '/chat/completions';
const DEFAULT_MAX_TOKENS = 65536;

// Read API key: env var > key file.
async function resolveApiKey(env = process.env) {
  if (env.QWEN_API_KEY) return env.QWEN_API_KEY;
  const keyfile = path.join(env.HOME || os.homedir(), '.qwen-key');
  try {
    const key = (await readFile(keyfile, 'utf8')).trim();
    if (key) return key;
  } catch { /* not found */ }
  throw Object.assign(new ProviderError('QWEN_API_KEY not set and ~/.qwen-key not found', 'AUTH_FAILURE'), { code: 'AUTH_FAILURE' });
}

// Map ocask model IDs to Alibaba DashScope model IDs.
const MODEL_MAP = {
  'qwen3.7-max': 'qwen-max',
  'qwen3.6-plus': 'qwen-plus-2025',   // fallback to latest plus
  'qwen3.6-pro': 'qwen-plus',
};

function apiModel(model) {
  return identityTransportRoute(model, 'qwen') || MODEL_MAP[model] || model;
}

function classifyError(status, body) {
  if (status === 401 || status === 403) return 'AUTH_FAILURE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status >= 500) return 'PROVIDER_ERROR';
  if (status === 400 && body?.code?.includes('InvalidParameter')) return 'MALFORMED_RESPONSE';
  if (status === 402) return 'INSUFFICIENT_BALANCE';   // Alibaba-specific
  return 'PROVIDER_ERROR';
}

function isEntitlementUnavailable(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text || '');
  return /not supported|model_not_supported|model is unavailable/i.test(s);
}

// Extract structured error from Alibaba's response format.
// Alibaba returns: { code: "InvalidApiKey", message: "...", request_id: "..." }
function extractQwenErrorMessage(body) {
  if (body?.message) return body.message;
  if (body?.code) return `${body.code}${body.request_id ? ` [${body.request_id}]` : ''}`;
  return 'Unknown error';
}

export async function invoke({ model, prompt, timeoutMs = 0, env = process.env, cwd = process.cwd() }) {
  if (!isQwenModel(model)) throw Object.assign(new ProviderError(`Not a Qwen model: ${model}`, 'MODEL_NOT_FOUND'), { code: 'MODEL_NOT_FOUND' });

  const apiKey = await resolveApiKey(env);
  const apiModelId = apiModel(model);
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  // Detect billing plan from env. Token Plan requires x-dashscope-plugin header.
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (env.QWEN_TOKEN_PLAN) {
    // Token Plan: requires the plugin header for qwen-plus/qwen-max
    headers['x-dashscope-plugin'] = JSON.stringify({ model: apiModelId });
  }

  let response;
  try {
    response = await fetch(`${BASE_URL}${CHAT_ENDPOINT}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: apiModelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: DEFAULT_MAX_TOKENS,
        temperature: 0,
        ...(env.QWEN_TOKEN_PLAN ? {} : {}),  // Token Plan may use different params
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw Object.assign(new ProviderError(`Qwen API timed out after ${timeoutMs}ms`, 'TIMEOUT'), { code: 'TIMEOUT' });
    }
    throw Object.assign(new ProviderError(`Qwen API connection failed: ${error.message}`, 'CONNECTION_ERROR'), { code: 'CONNECTION_ERROR' });
  }

  if (timeout) clearTimeout(timeout);

  let body;
  try {
    body = await response.json();
  } catch {
    const text = await response.text().catch(() => '');
    const code = classifyError(response.status, {});
    const msg = `Qwen API returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
    throw Object.assign(new ProviderError(msg, code), { code, status: response.status });
  }

  if (!response.ok) {
    const code = classifyError(response.status, body);
    const msg = extractQwenErrorMessage(body);

    if (isEntitlementUnavailable(body) || code === 'MODEL_NOT_FOUND') {
      throw Object.assign(new ProviderError(`Qwen model unavailable: ${msg}`, 'ENTITLEMENT_UNAVAILABLE'), { code: 'ENTITLEMENT_UNAVAILABLE', status: response.status });
    }
    if (code === 'RATE_LIMITED') {
      const retryAfter = response.headers.get('retry-after') || 'unknown';
      throw Object.assign(new ProviderError(`Qwen rate limited (retry after ${retryAfter}s)`, 'RATE_LIMITED'), { code: 'RATE_LIMITED', retryAfter, status: 429 });
    }
    if (code === 'AUTH_FAILURE') {
      throw Object.assign(new ProviderError(`Qwen auth failed: ${msg}`, 'AUTH_FAILURE'), { code: 'AUTH_FAILURE', status: response.status });
    }
    if (code === 'INSUFFICIENT_BALANCE') {
      throw Object.assign(new ProviderError(`Qwen billing: insufficient balance — check Alibaba console`, 'INSUFFICIENT_BALANCE'), { code: 'INSUFFICIENT_BALANCE', status: 402 });
    }
    throw Object.assign(new ProviderError(`Qwen API error: ${msg}`, code), { code, status: response.status });
  }

  // Parse response content. Alibaba uses standard OpenAI format.
  const choice = body?.choices?.[0];
  if (!choice?.message?.content) {
    // Qwen sometimes returns through 'output' field (DashScope native format)
    const outputText = body?.output?.text || body?.output?.choices?.[0]?.message?.content;
    if (outputText) {
      const stdout = JSON.stringify([
        { type: 'text', timestamp: Date.now(), part: { type: 'text', text: outputText } },
      ]);
      const returnedRoute = typeof body.model === 'string' && body.model ? body.model : apiModelId;
      return {
        stdout, stderr: '', provider: 'qwen',
        model_used: returnedRoute === apiModelId ? model : returnedRoute,
        model_route: apiModelId, provider_model_used: returnedRoute,
        tokensUsed: { input: 0, output: 0, total: 0 },
      };
    }
    throw Object.assign(new ProviderError('Qwen returned empty response content', 'MALFORMED_RESPONSE'), { code: 'MALFORMED_RESPONSE' });
  }

  const stdout = JSON.stringify([
    { type: 'text', timestamp: Date.now(), part: { type: 'text', text: choice.message.content } },
  ]);

  const usage = body.usage || {};
  const stderr = `[Qwen API] tokens: ${usage.prompt_tokens || 0} in / ${usage.completion_tokens || 0} out / ${usage.total_tokens || 0} total`;
  const returnedRoute = typeof body.model === 'string' && body.model ? body.model : apiModelId;
  const modelUsed = returnedRoute === apiModelId ? model : returnedRoute;

  return {
    stdout, stderr, provider: 'qwen', model_used: modelUsed, model_route: apiModelId,
    provider_model_used: returnedRoute,
    tokensUsed: { input: usage.input_tokens || usage.prompt_tokens || 0, output: usage.output_tokens || usage.completion_tokens || 0, total: usage.total_tokens || 0 },
  };
}
