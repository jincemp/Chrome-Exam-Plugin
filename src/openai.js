/*
 * OpenAI client.
 *
 * Runs in the service worker (and in the options page for the key test), which
 * is the only extension context whose fetch() bypasses CORS for a host listed in
 * host_permissions. The key goes to the configured base URL and nowhere else.
 *
 * Requests default to POST /v1/responses - the endpoint OpenAI recommends for
 * new integrations - and fall back to /v1/chat/completions when the endpoint is
 * missing, which is what most OpenAI-compatible proxies expose. The two have
 * genuinely different request shapes, so each is built separately rather than
 * patched from a common object.
 */

import { ANSWER_SCHEMA, SCHEMA_NAME, buildPrompt } from './prompt.js';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;

/** Models that reject `temperature` outright and bill their thinking as output. */
const REASONING_RE = /^(o\d|gpt-[5-9])/i;

/** Remembers which endpoint a given base URL actually implements. */
const endpointCache = new Map();

/**
 * Remembers which request parameters a given base URL and model tolerate, so a
 * page split into several chunks pays for a rejected parameter once rather than
 * once per chunk. Lives only as long as the service worker.
 */
const capsCache = new Map();

export class OpenAIError extends Error {
  constructor(message, { status = 0, code = '', param = '', hint = '', retryable = false, kind = 'api', origins = [] } = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
    this.code = code;
    this.param = param;
    this.hint = hint;
    this.retryable = retryable;
    this.kind = kind;
    this.origins = origins;
  }
}

/** The model ran out of room mid-answer; the caller can retry with less input. */
export class TruncatedError extends Error {
  constructor(message = 'The answer was cut off before it finished.') {
    super(message);
    this.name = 'TruncatedError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const baseOf = (settings) => (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');

const authHeaders = (settings) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${settings.apiKey}`,
});

/* ------------------------------------------------------------------ errors */

/** Turn an HTTP failure into something worth showing in a 300px popup. */
async function toError(response, settings) {
  let payload = null;
  try {
    payload = await response.json();
  } catch { /* some gateways answer with HTML */ }
  return classifyError(response.status, payload, settings);
}

/** @param {number} status @param {object|null} payload @param {object} [settings] */
export function classifyError(status, payload, settings) {
  const err = payload?.error || {};
  const code = err.code || err.type || '';
  const detail = err.message || '';
  const param = err.param || '';

  if (status === 401) {
    return new OpenAIError('OpenAI rejected your API key.', {
      status, code, param, kind: 'auth',
      hint: code === 'invalid_organization'
        ? 'The key has no access to this organisation.'
        : 'Check the key in settings — it may be revoked or mistyped.',
    });
  }
  if (status === 403) {
    return new OpenAIError(detail || 'Your account may not use this model.', {
      status, code, param, kind: 'auth', hint: 'Some models require a verified organisation.',
    });
  }
  if (status === 404) {
    const model = settings?.model ? `"${settings.model}"` : 'that model';
    return new OpenAIError(
      code === 'model_not_found' ? `Model ${model} does not exist or your key has no access to it.` : (detail || 'Not found.'),
      { status, code, param, kind: code === 'model_not_found' ? 'model' : 'endpoint', hint: 'Pick a different model in settings.' },
    );
  }
  if (status === 429) {
    const outOfCredit = code === 'insufficient_quota' || /quota|billing/i.test(detail);
    return new OpenAIError(outOfCredit ? 'Your OpenAI account is out of credit.' : 'OpenAI is rate limiting this key.', {
      status, code, param, retryable: !outOfCredit, kind: outOfCredit ? 'quota' : 'rate',
      hint: outOfCredit
        ? 'Add credit at platform.openai.com/settings/organization/billing.'
        : 'Waiting a few seconds usually clears it.',
    });
  }
  if (status === 405 || status === 501) {
    return new OpenAIError(detail || 'That endpoint is not available here.', {
      status, code, param, kind: 'endpoint', hint: 'Set the endpoint explicitly in advanced settings.',
    });
  }
  if (status >= 500) {
    return new OpenAIError('OpenAI had a server error.', { status, code, param, retryable: true, hint: 'Usually transient.' });
  }
  // Too much page text for this model. The caller can split and try again, so
  // report it the same way as an answer that ran out of room.
  if (status === 400 && (code === 'context_length_exceeded' || /context length|too many tokens|maximum context/i.test(detail))) {
    return new TruncatedError('That part of the page was too long for this model.');
  }
  return new OpenAIError(detail || `OpenAI returned HTTP ${status}.`, { status, code, param });
}

const networkError = (cause) =>
  new OpenAIError('Could not reach OpenAI.', {
    kind: 'network',
    retryable: true,
    hint: cause?.message ? `Network error: ${cause.message}` : 'Check your internet connection.',
  });

/* ------------------------------------------------------------------- fetch */

async function request(settings, path, init, signal) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(`${baseOf(settings)}${path}`, { ...init, signal });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      lastError = networkError(cause);
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) return response.json();

    const error = await toError(response, settings);
    if (!error.retryable || attempt === MAX_ATTEMPTS) throw error;

    // Honour Retry-After when the server sends one; otherwise back off.
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 20000)
      : BASE_BACKOFF_MS * 2 ** (attempt - 1));
    lastError = error;
  }

  throw lastError || new OpenAIError('OpenAI request failed.');
}

/* ------------------------------------------------------------------ models */

export async function listModels(settings) {
  const data = await request(settings, '/models', { method: 'GET', headers: authHeaders(settings) });
  return (data?.data || []).map((m) => m.id).filter(Boolean);
}

/* ------------------------------------------------------------ request shape */

/**
 * What we are still willing to ask for. Anything the model rejects gets peeled
 * off and the request is retried, so an unfamiliar or proxied model still works
 * without the user touching settings.
 */
export function initialCaps(settings) {
  const reasoning = REASONING_RE.test(settings.model || '');
  return {
    // 'json_schema' -> 'json_object' -> 'none'. Some gateways support neither.
    format: 'json_schema',
    reasoning,
    verbosity: true,
    maxTokens: true,
    temperature: !reasoning,
    store: true,
  };
}

export function buildResponsesBody(settings, prompt, caps) {
  const body = {
    model: settings.model,
    instructions: prompt.system,
    input: [{ role: 'user', content: prompt.user }],
  };

  const text = {};
  if (caps.format === 'json_schema') {
    text.format = { type: 'json_schema', name: SCHEMA_NAME, strict: true, schema: ANSWER_SCHEMA };
  } else if (caps.format === 'json_object') {
    text.format = { type: 'json_object' };
  }
  if (caps.verbosity) text.verbosity = 'low';
  if (Object.keys(text).length) body.text = text;

  if (caps.reasoning) body.reasoning = { effort: effortOf(settings) };
  if (caps.temperature) body.temperature = 0;
  if (caps.maxTokens) body.max_output_tokens = maxTokensFor(settings);
  if (caps.store) body.store = false; // do not leave exam content on OpenAI's servers
  return body;
}

export function buildChatBody(settings, prompt, caps) {
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  };

  if (caps.format === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: true, schema: ANSWER_SCHEMA } };
  } else if (caps.format === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  if (caps.reasoning) body.reasoning_effort = effortOf(settings);
  if (caps.verbosity) body.verbosity = 'low';
  if (caps.temperature) body.temperature = 0;
  if (caps.maxTokens) body.max_completion_tokens = maxTokensFor(settings);
  if (caps.store) body.store = false; // same promise as the Responses path
  return body;
}

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Guards against a stale or hand-edited value reaching the API. */
const effortOf = (settings) => (EFFORTS.has(settings.effort) ? settings.effort : 'low');

/** Reasoning tokens are billed against the same budget, so leave headroom. */
function maxTokensFor(settings) {
  const effort = effortOf(settings);
  if (!REASONING_RE.test(settings.model || '')) return 8000;
  return { max: 64000, xhigh: 48000, high: 32000, medium: 24000 }[effort] || 16000;
}

/* --------------------------------------------------------------- responses */

/**
 * `status` is one of completed | failed | incomplete | in_progress | queued |
 * cancelled, and a failure at this level carries its own {code, message} shape -
 * not the HTTP error envelope.
 */
export function parseResponsesPayload(data) {
  if (data?.status === 'failed') {
    const code = data.error?.code || '';
    throw new OpenAIError(data.error?.message || 'OpenAI could not complete the request.', {
      code,
      kind: code === 'content_policy_violation' ? 'refusal' : 'api',
      retryable: code === 'server_error' || code === 'rate_limit_exceeded',
    });
  }
  if (data?.status && data.status !== 'completed') {
    const reason = data.incomplete_details?.reason || data.status;
    if (reason === 'max_output_tokens') throw new TruncatedError();
    if (reason === 'content_filter') {
      throw new OpenAIError('OpenAI filtered the response.', { kind: 'refusal' });
    }
    throw new OpenAIError(`OpenAI returned an incomplete response (${reason}).`, { retryable: true });
  }

  const items = Array.isArray(data?.output) ? data.output : [];
  const messages = items.filter((i) => i?.type === 'message');

  // A model may emit a phase:"commentary" message before its real answer, so
  // take the last non-commentary one rather than the first message of any kind.
  const message = messages.filter((m) => m.phase !== 'commentary').pop() || messages.pop();
  const parts = Array.isArray(message?.content) ? message.content : [];

  const refusal = parts.find((p) => p?.type === 'refusal');
  if (refusal) throw new OpenAIError(`The model declined: ${refusal.refusal}`, { kind: 'refusal' });

  const textPart = parts.find((p) => p?.type === 'output_text');
  // `output_text` is documented as an SDK-only convenience, but some gateways
  // do send it over the wire; accept either.
  const content = textPart?.text ?? (typeof data?.output_text === 'string' ? data.output_text : '');
  if (!content) throw new OpenAIError('OpenAI returned an empty response.');
  return content;
}

export function parseChatPayload(data) {
  const choice = data?.choices?.[0];
  if (choice?.message?.refusal) {
    throw new OpenAIError(`The model declined: ${choice.message.refusal}`, { kind: 'refusal' });
  }
  if (choice?.finish_reason === 'length') throw new TruncatedError();

  const content = choice?.message?.content;
  if (!content) throw new OpenAIError('OpenAI returned an empty response.');
  return content;
}

/* ----------------------------------------------------------------- answers */

/**
 * Ask for an answer sheet.
 *
 * @param {object} settings
 * @param {object} promptInput  see buildPrompt
 * @param {AbortSignal} [signal]
 * @returns {Promise<{questions: Array<object>, usage: object|null, model: string}>}
 */
export async function answerQuestions(settings, promptInput, signal) {
  const base = baseOf(settings);
  const capsKey = `${base}|${settings.model}`;
  const caps = { ...initialCaps(settings), ...(capsCache.get(capsKey) || {}) };
  let endpoint = settings.endpoint && settings.endpoint !== 'auto'
    ? settings.endpoint
    : endpointCache.get(base) || 'responses';

  // Each pass either succeeds or removes one thing the model objected to.
  for (let pass = 0; pass < 12; pass++) {
    const prompt = buildPrompt({ ...promptInput, schemaEnforced: caps.format === 'json_schema' });
    const responses = endpoint === 'responses';
    const path = responses ? '/responses' : '/chat/completions';
    const body = responses ? buildResponsesBody(settings, prompt, caps) : buildChatBody(settings, prompt, caps);

    let data;
    try {
      data = await request(settings, path, {
        method: 'POST',
        headers: authHeaders(settings),
        body: JSON.stringify(body),
      }, signal);
    } catch (err) {
      if (!(err instanceof OpenAIError)) throw err;

      // Base URL does not implement /responses - almost always a proxy.
      if (responses && err.kind === 'endpoint' && settings.endpoint !== 'responses') {
        endpoint = 'chat';
        endpointCache.set(base, 'chat');
        continue;
      }
      if (err.status === 400 && relaxCaps(err, caps)) continue;
      throw err;
    }

    endpointCache.set(base, endpoint);
    capsCache.set(capsKey, { ...caps });
    const content = responses ? parseResponsesPayload(data) : parseChatPayload(data);
    return { questions: parseQuestions(content), usage: data.usage || null, model: data.model || settings.model };
  }

  throw new OpenAIError('OpenAI rejected every request shape we tried.', {
    hint: 'Try a different model in settings.',
  });
}

/** Mutates `caps`; returns true when something was dropped and a retry is worth it. */
export function relaxCaps(err, caps) {
  const text = `${err.param || ''} ${err.code || ''} ${err.message || ''}`.toLowerCase();

  const weakenFormat = () => {
    if (caps.format === 'json_schema') { caps.format = 'json_object'; return true; }
    if (caps.format === 'json_object') { caps.format = 'none'; return true; }
    return false;
  };

  if (caps.temperature && /temperature|top_p/.test(text)) { caps.temperature = false; return true; }
  if (caps.reasoning && /reasoning/.test(text)) { caps.reasoning = false; return true; }
  if (caps.verbosity && /verbosity/.test(text)) { caps.verbosity = false; return true; }
  if (caps.store && /\bstore\b/.test(text)) { caps.store = false; return true; }
  if (caps.maxTokens && /max_(output|completion)_tokens|max_tokens/.test(text)) { caps.maxTokens = false; return true; }
  if (/json_schema|json_object|response_format|\bschema\b|\bformat\b|structured/.test(text) && weakenFormat()) return true;

  // Unknown 400: shed parameters in order of how little we need them. `store` is
  // deliberately absent - it only comes off when the server names it, because
  // dropping it silently opts the user's exam text into retention.
  if (caps.verbosity) { caps.verbosity = false; return true; }
  if (caps.reasoning) { caps.reasoning = false; return true; }
  if (caps.temperature) { caps.temperature = false; return true; }
  if (caps.maxTokens) { caps.maxTokens = false; return true; }
  return weakenFormat();
}

/** Accepts the strict schema shape and the looser shapes json_object mode produces. */
export function parseQuestions(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    const match = /[[{][\s\S]*[\]}]/.exec(content);
    if (!match) throw new OpenAIError('OpenAI did not return usable JSON.');
    try {
      data = JSON.parse(match[0]);
    } catch {
      throw new OpenAIError('OpenAI did not return usable JSON.');
    }
  }

  const raw = Array.isArray(data) ? data
    : Array.isArray(data?.questions) ? data.questions
    : Array.isArray(data?.answers) ? data.answers
    : [];

  return raw
    .map((q, i) => ({
      number: String(q?.number ?? q?.q ?? q?.id ?? i + 1).trim().replace(/^q/i, '').replace(/[.:)]+$/, ''),
      label: String(q?.label ?? q?.option ?? q?.choice ?? '').trim().replace(/^[([]+/, '').replace(/[).\]]+$/, ''),
      answer: String(q?.answer ?? q?.text ?? '').trim(),
      why: String(q?.why ?? q?.reason ?? q?.explanation ?? '').trim(),
      confidence: ['high', 'medium', 'low'].includes(q?.confidence) ? q.confidence : 'medium',
    }))
    .filter((q) => q.answer || q.label);
}
