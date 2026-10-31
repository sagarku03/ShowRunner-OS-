import fs from 'node:fs';
import path from 'node:path';

export interface MappedGeminiError {
  code: string;
  httpStatus: number;
  userMessage: string;
  retryable: boolean;
  raw: string;
}

const KEY_REDACT_RE = new RegExp('AI' + 'za[0-9A-Za-z_-]{10,}', 'g');
const TOKEN_REDACT_RE = new RegExp('A' + 'Q\\.[0-9A-Za-z_-]{10,}', 'g');

export function sanitizeSecretMaterial(input: string): string {
  return String(input || '')
    .replace(/key=[0-9A-Za-z_-]+/gi, 'key=[REDACTED]')
    .replace(KEY_REDACT_RE, '[REDACTED_KEY]')
    .replace(TOKEN_REDACT_RE, '[REDACTED_TOKEN]');
}

/**
 * Maps any LLM / application error into a structured, sanitized shape:
 * `{ code, httpStatus, userMessage, retryable, raw }`.
 */
export function mapGeminiError(err: unknown, keyLabel?: string): MappedGeminiError {
  const errObj = (err ?? {}) as {
    message?: string;
    code?: string;
    status?: number;
    statusCode?: number;
    httpStatus?: number;
    retryable?: boolean;
  };

  const rawMsg = sanitizeSecretMaterial(errObj.message || String(err || 'Unknown error'));
  const lower = rawMsg.toLowerCase();
  const explicitStatus = errObj.httpStatus ?? errObj.statusCode ?? errObj.status;
  const explicitCode = typeof errObj.code === 'string' ? errObj.code : undefined;

  // Preserve domain-specific typed errors when explicitly set by gates/stages
  if (
    explicitCode &&
    explicitCode !== 'ERR_INVALID_ARG_TYPE' &&
    ![
      'INVALID_KEY',
      'QUOTA_EXCEEDED',
      'MODEL_ACCESS_DENIED',
      'NETWORK_ERROR',
      'GEMINI_BAD_REQUEST',
    ].includes(explicitCode)
  ) {
    const status = explicitStatus && explicitStatus >= 400 ? explicitStatus : 422;
    const retryable =
      typeof errObj.retryable === 'boolean'
        ? errObj.retryable
        : status === 429 || status === 502 || status === 503;
    return {
      code: explicitCode,
      httpStatus: status,
      userMessage: rawMsg,
      retryable,
      raw: rawMsg,
    };
  }

  // 1. Auth / Invalid API key (401 / 403 invalid key)
  if (
    explicitCode === 'INVALID_KEY' ||
    explicitStatus === 401 ||
    lower.includes('api_key_invalid') ||
    lower.includes('invalid api key') ||
    lower.includes('unauthenticated') ||
    lower.includes('http 401')
  ) {
    const prefix = keyLabel ? `Key ${keyLabel} rejected` : 'Key rejected';
    return {
      code: 'INVALID_KEY',
      httpStatus: 401,
      userMessage: `${prefix}: API key is invalid or unauthorized. Open Vault and replace or test the key.`,
      retryable: false,
      raw: rawMsg,
    };
  }

  // 2. Model access denied / 403 permission denied
  if (
    explicitCode === 'MODEL_ACCESS_DENIED' ||
    explicitStatus === 403 ||
    lower.includes('permission_denied') ||
    lower.includes('http 403')
  ) {
    const prefix = keyLabel ? `Key ${keyLabel} rejected` : 'Model access denied';
    return {
      code: 'MODEL_ACCESS_DENIED',
      httpStatus: 403,
      userMessage: `${prefix}: This key does not have permission to access the selected Gemini model.`,
      retryable: false,
      raw: rawMsg,
    };
  }

  // 3. Model not found (404)
  if (
    explicitStatus === 404 ||
    lower.includes('not_found') ||
    lower.includes('http 404') ||
    (lower.includes('model') && lower.includes('not found'))
  ) {
    return {
      code: 'MODEL_NOT_FOUND',
      httpStatus: 404,
      userMessage:
        'Selected Gemini model was not found on this API version. Open Vault -> Test key -> pick an available model.',
      retryable: false,
      raw: rawMsg,
    };
  }

  // 4. Rate limit / Quota exceeded (429)
  if (
    explicitCode === 'QUOTA_EXCEEDED' ||
    explicitStatus === 429 ||
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return {
      code: 'QUOTA_EXCEEDED',
      httpStatus: 429,
      userMessage:
        'Gemini rate limit or quota reached on active key(s). Add another key in Vault or retry after cooldown.',
      retryable: true,
      raw: rawMsg,
    };
  }

  // 5. Bad Request / Schema + Grounding conflict (400)
  if (
    explicitStatus === 400 ||
    lower.includes('http 400') ||
    lower.includes('invalid_argument') ||
    lower.includes('response_schema') ||
    (lower.includes('search') && lower.includes('schema'))
  ) {
    return {
      code: 'GEMINI_BAD_REQUEST',
      httpStatus: 400,
      userMessage:
        'Gemini rejected the request payload or schema configuration (HTTP 400). Check technical details.',
      retryable: false,
      raw: rawMsg,
    };
  }

  // 6. Safety block
  if (
    lower.includes('safety') ||
    lower.includes('blocked') ||
    lower.includes('prohibited_content') ||
    lower.includes('finishreason: safety')
  ) {
    return {
      code: 'SAFETY_BLOCKED',
      httpStatus: 422,
      userMessage:
        'Generation was blocked by Gemini safety filters. Adjust the topic or wording and try again.',
      retryable: false,
      raw: rawMsg,
    };
  }

  // 7. Empty response
  if (lower.includes('empty response') || lower.includes('empty_response')) {
    return {
      code: 'EMPTY_LLM_RESPONSE',
      httpStatus: 502,
      userMessage: 'Gemini returned an empty response. Click Retry to regenerate.',
      retryable: true,
      raw: rawMsg,
    };
  }

  // 8. JSON parse failure
  if (
    err instanceof SyntaxError ||
    lower.includes('unexpected token') ||
    lower.includes('json at position') ||
    lower.includes('json parse')
  ) {
    return {
      code: 'LLM_JSON_PARSE_FAILED',
      httpStatus: 502,
      userMessage: 'Gemini returned malformed JSON output. Click Retry to run structured generation again.',
      retryable: true,
      raw: rawMsg,
    };
  }

  // 9. Network / DNS / fetch failure
  if (
    explicitCode === 'NETWORK_ERROR' ||
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('network')
  ) {
    return {
      code: 'NETWORK_ERROR',
      httpStatus: 503,
      userMessage: 'Network error while contacting Gemini API. Check internet connection and retry.',
      retryable: true,
      raw: rawMsg,
    };
  }

  // 10. Upstream 5xx
  if (
    (explicitStatus && explicitStatus >= 500) ||
    lower.includes('503') ||
    lower.includes('500') ||
    lower.includes('overloaded') ||
    lower.includes('internal error')
  ) {
    return {
      code: 'GEMINI_UPSTREAM_5XX',
      httpStatus: 502,
      userMessage: 'Gemini upstream servers are temporarily overloaded (5xx). Retry in a few seconds.',
      retryable: true,
      raw: rawMsg,
    };
  }

  return {
    code: explicitCode || 'INTERNAL_ERROR',
    httpStatus: explicitStatus && explicitStatus >= 400 ? explicitStatus : 500,
    userMessage: rawMsg,
    retryable: false,
    raw: rawMsg,
  };
}

export interface RedactedLlmLogEntry {
  stage: string;
  tier: string;
  model: string;
  keyLabel: string;
  latencyMs: number;
  outcome: string;
}

/**
 * Appends a single redacted line per LLM call to `server.log`.
 * Never writes API keys or tokens.
 */
export function logRedactedLlmCall(entry: RedactedLlmLogEntry): void {
  try {
    const logPath = path.resolve(process.cwd(), 'server.log');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      stage: sanitizeSecretMaterial(entry.stage),
      tier: sanitizeSecretMaterial(entry.tier),
      model: sanitizeSecretMaterial(entry.model),
      keyLabel: sanitizeSecretMaterial(entry.keyLabel),
      latencyMs: Math.round(entry.latencyMs),
      outcome: sanitizeSecretMaterial(entry.outcome),
    });
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {
    // Non-fatal if filesystem is read-only
  }
}
