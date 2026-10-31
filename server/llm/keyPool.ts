import type { DatabaseSync } from 'node:sqlite';
import { COOLDOWN_429_MS, type KeyValidationStatus } from '../../src/config/constants.ts';
import type { ShowRunnerMode } from '../../src/config/runtime.ts';
import { decryptApiKey, encryptApiKey, hashApiKey, maskApiKey } from '../security/vault.ts';
import { sanitizeSecretMaterial } from './errors.ts';
import { fetchLiveGeminiModels, type ModelDiscoveryResult } from './models.ts';

export type VaultKeyType = 'GEMINI' | 'YOUTUBE';

export type VaultKeyStatus =
  | KeyValidationStatus
  | 'ACTIVE'
  | 'COOLDOWN_429'
  | 'EXHAUSTED'
  | 'INVALID'
  | 'UNREADABLE';

export interface VaultKeyRecord {
  id: number;
  projectLabel: string;
  maskedKey: string;
  keyType: VaultKeyType;
  status: VaultKeyStatus;
  cooldownUntil: string | null;
  failureCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  discoveredModels: ModelDiscoveryResult | null;
  validationMessage?: string;
  createdAt: string;
}

export interface DecryptedKeyCandidate {
  id: number;
  projectLabel: string;
  maskedKey: string;
  keyType: VaultKeyType;
  apiKey: string;
  discoveredModels: ModelDiscoveryResult | null;
}

export type DecryptedActiveKey = DecryptedKeyCandidate;

export interface LiveKeyValidationOutcome {
  status: KeyValidationStatus;
  lastCheckedAt: string;
  lastError: string | null;
  humanMessage: string;
  discoveredModels: ModelDiscoveryResult | null;
}

function parseDiscoveredModels(jsonStr: string | null | undefined): ModelDiscoveryResult | null {
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr) as ModelDiscoveryResult;
  } catch {
    return null;
  }
}

/**
 * Runs a live validation against `/v1beta/models` and a 1-token `generateContent` call
 * on the discovered fast model (or YouTube Data API v3 for `YOUTUBE` keys).
 */
export async function validateApiKeyLive(
  rawKey: string,
  keyType: VaultKeyType = 'GEMINI',
  customFetch: typeof fetch = fetch
): Promise<LiveKeyValidationOutcome> {
  const trimmedKey = rawKey.trim();
  const checkedAt = new Date().toISOString();

  if (trimmedKey.length < 10) {
    return {
      status: 'INVALID_KEY',
      lastCheckedAt: checkedAt,
      lastError: 'API key is too short.',
      humanMessage: 'Key rejected: API key is too short.',
      discoveredModels: null,
    };
  }

  if (keyType === 'YOUTUBE') {
    try {
      const ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=id&id=UC_x5XG1OV2P6uZZ5FSM9Ttw&key=${encodeURIComponent(
        trimmedKey
      )}`;
      const res = await customFetch(ytUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        return {
          status: 'VALID',
          lastCheckedAt: checkedAt,
          lastError: null,
          humanMessage: 'YouTube Data API v3 key verified and active.',
          discoveredModels: null,
        };
      }
      const errBody = sanitizeSecretMaterial(await res.text().catch(() => ''));
      if (res.status === 401 || res.status === 400 || errBody.toLowerCase().includes('keyinvalid')) {
        return {
          status: 'INVALID_KEY',
          lastCheckedAt: checkedAt,
          lastError: `HTTP ${res.status}: ${errBody.slice(0, 180)}`,
          humanMessage: 'YouTube API key is invalid.Key was not activated.',
          discoveredModels: null,
        };
      }
      if (res.status === 429 || errBody.toLowerCase().includes('quota')) {
        return {
          status: 'QUOTA_EXCEEDED',
          lastCheckedAt: checkedAt,
          lastError: `HTTP ${res.status}: ${errBody.slice(0, 180)}`,
          humanMessage: 'YouTube Data API v3 quota exceeded.',
          discoveredModels: null,
        };
      }
      return {
        status: 'MODEL_ACCESS_DENIED',
        lastCheckedAt: checkedAt,
        lastError: `HTTP ${res.status}: ${errBody.slice(0, 180)}`,
        humanMessage: `YouTube API access denied (HTTP ${res.status}).`,
        discoveredModels: null,
      };
    } catch (err) {
      const clean = sanitizeSecretMaterial((err as Error)?.message || String(err));
      return {
        status: 'NETWORK_ERROR',
        lastCheckedAt: checkedAt,
        lastError: clean,
        humanMessage: `Network error while validating YouTube key: ${clean}`,
        discoveredModels: null,
      };
    }
  }

  // Step 1: Discover models via /v1beta/models
  let discovery: ModelDiscoveryResult;
  try {
    discovery = await fetchLiveGeminiModels(trimmedKey, customFetch);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const clean = sanitizeSecretMaterial((err as Error)?.message || String(err));
    const lower = clean.toLowerCase();

    if (status === 401 || status === 400 || lower.includes('api_key_invalid') || lower.includes('invalid api key')) {
      return {
        status: 'INVALID_KEY',
        lastCheckedAt: checkedAt,
        lastError: clean,
        humanMessage: 'Gemini API key is invalid (HTTP 401). Key was not activated.',
        discoveredModels: null,
      };
    }
    if (status === 429 || lower.includes('429') || lower.includes('quota') || lower.includes('resource_exhausted')) {
      return {
        status: 'QUOTA_EXCEEDED',
        lastCheckedAt: checkedAt,
        lastError: clean,
        humanMessage: 'Gemini API key quota exceeded (HTTP 429). Key was not activated.',
        discoveredModels: null,
      };
    }
    if (status === 403 || lower.includes('permission_denied') || lower.includes('403')) {
      return {
        status: 'MODEL_ACCESS_DENIED',
        lastCheckedAt: checkedAt,
        lastError: clean,
        humanMessage: 'Gemini API key does not have model access permission (HTTP 403).',
        discoveredModels: null,
      };
    }
    return {
      status: 'NETWORK_ERROR',
      lastCheckedAt: checkedAt,
      lastError: clean,
      humanMessage: `Network error during model discovery: ${clean}`,
      discoveredModels: null,
    };
  }

  const fastCandidate =
    discovery.recommendedFast ||
    discovery.fastModels[0]?.id ||
    discovery.recommendedReasoning ||
    discovery.reasoningModels[0]?.id;

  if (!fastCandidate) {
    return {
      status: 'MODEL_ACCESS_DENIED',
      lastCheckedAt: checkedAt,
      lastError: 'No generateContent-capable Gemini models returned for this key.',
      humanMessage:
        'Key authenticated, but zero generateContent models were returned by /v1beta/models.',
      discoveredModels: discovery,
    };
  }

  // Step 2: 1-token generateContent probe on the discovered fast model
  try {
    const probeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      fastCandidate
    )}:generateContent?key=${encodeURIComponent(trimmedKey)}`;
    const probeRes = await customFetch(probeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    });

    if (!probeRes.ok) {
      const errText = sanitizeSecretMaterial(await probeRes.text().catch(() => ''));
      const lower = errText.toLowerCase();
      if (probeRes.status === 401 || lower.includes('api_key_invalid')) {
        return {
          status: 'INVALID_KEY',
          lastCheckedAt: checkedAt,
          lastError: `HTTP ${probeRes.status}: ${errText.slice(0, 180)}`,
          humanMessage: 'Gemini API key rejected during 1-token generation probe.',
          discoveredModels: discovery,
        };
      }
      if (probeRes.status === 429 || lower.includes('quota') || lower.includes('resource_exhausted')) {
        return {
          status: 'QUOTA_EXCEEDED',
          lastCheckedAt: checkedAt,
          lastError: `HTTP ${probeRes.status}: ${errText.slice(0, 180)}`,
          humanMessage: 'Gemini API key quota exceeded during 1-token generation test (HTTP 429).',
          discoveredModels: discovery,
        };
      }
      if (probeRes.status === 403 || probeRes.status === 404) {
        return {
          status: 'MODEL_ACCESS_DENIED',
          lastCheckedAt: checkedAt,
          lastError: `HTTP ${probeRes.status}: ${errText.slice(0, 180)}`,
          humanMessage: `Model "${fastCandidate}" access denied (HTTP ${probeRes.status}).`,
          discoveredModels: discovery,
        };
      }
      return {
        status: 'NETWORK_ERROR',
        lastCheckedAt: checkedAt,
        lastError: `HTTP ${probeRes.status}: ${errText.slice(0, 180)}`,
        humanMessage: `Probe failed with HTTP ${probeRes.status}.`,
        discoveredModels: discovery,
      };
    }
  } catch (err) {
    const clean = sanitizeSecretMaterial((err as Error)?.message || String(err));
    return {
      status: 'NETWORK_ERROR',
      lastCheckedAt: checkedAt,
      lastError: clean,
      humanMessage: `Network error during 1-token probe: ${clean}`,
      discoveredModels: discovery,
    };
  }

  const totalModels =
    discovery.reasoningModels.length +
    discovery.fastModels.length +
    discovery.embeddingModels.length;

  return {
    status: 'VALID',
    lastCheckedAt: checkedAt,
    lastError: null,
    humanMessage: `Key verified (${totalModels} models discovered; fast probe passed on ${fastCandidate}).`,
    discoveredModels: discovery,
  };
}

/**
 * In `preview` mode, if `process.env.GEMINI_API_KEY` is present and valid (not placeholder),
 * registers it in `api_keys` as "AI Studio Secret" so it participates in the failover pool
 * without overriding other keys.
 */
export function syncPreviewSecretKeyIfPresent(db: DatabaseSync, mode: ShowRunnerMode): void {
  if (mode !== 'preview') return;
  const rawSecret = process.env.GEMINI_API_KEY?.trim();
  if (!rawSecret || rawSecret === 'MY_GEMINI_API_KEY' || rawSecret.length < 12) {
    return;
  }

  const keyHash = hashApiKey(rawSecret);
  const existing = db
    .prepare(`SELECT id FROM api_keys WHERE key_hash = ?`)
    .get(keyHash) as { id: number } | undefined;
  if (existing) return;

  const encrypted = encryptApiKey(rawSecret);
  const masked = maskApiKey(rawSecret);
  db.prepare(
    `INSERT INTO api_keys (key_hash, encrypted_key, masked_key, project_label, key_type, status, failure_count)
     VALUES (?, ?, ?, 'AI Studio Secret', 'GEMINI', 'VALID', 0)`
  ).run(keyHash, encrypted, masked);
}

/**
 * Releases any keys whose `cooldown_until` timestamp has passed back to `VALID`.
 */
export function releaseExpiredCooldownKeys(db: DatabaseSync): void {
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE api_keys
     SET status = 'VALID', cooldown_until = NULL
     WHERE status IN ('COOLDOWN_429', 'COOLING_DOWN') AND cooldown_until IS NOT NULL AND cooldown_until <= ?`
  ).run(nowIso);
}

interface RawApiKeyRow {
  id: number;
  project_label: string;
  masked_key: string;
  key_type?: string;
  status: VaultKeyStatus;
  cooldown_until: string | null;
  failure_count: number;
  last_used_at: string | null;
  last_checked_at?: string | null;
  last_error?: string | null;
  discovered_models_json?: string | null;
  created_at: string;
}

function mapKeyRow(r: RawApiKeyRow, validationMessage?: string): VaultKeyRecord {
  return {
    id: r.id,
    projectLabel: r.project_label,
    maskedKey: r.masked_key,
    keyType: (r.key_type === 'YOUTUBE' ? 'YOUTUBE' : 'GEMINI') as VaultKeyType,
    status: r.status,
    cooldownUntil: r.cooldown_until,
    failureCount: r.failure_count,
    lastUsedAt: r.last_used_at,
    lastCheckedAt: r.last_checked_at ?? null,
    lastError: r.last_error ?? null,
    discoveredModels: parseDiscoveredModels(r.discovered_models_json),
    validationMessage,
    createdAt: r.created_at,
  };
}

/**
 * Lists all keys in `api_keys` (masked only; never returns plaintext or ciphertext to the client).
 */
export function listVaultKeys(db: DatabaseSync): VaultKeyRecord[] {
  releaseExpiredCooldownKeys(db);
  const rows = db
    .prepare(
      `SELECT id, project_label, masked_key, key_type, status, cooldown_until, failure_count,
              last_used_at, last_checked_at, last_error, discovered_models_json, created_at
       FROM api_keys
       ORDER BY id ASC`
    )
    .all() as unknown as RawApiKeyRow[];

  return rows.map((r) => mapKeyRow(r));
}

/**
 * Synchronous helper for internal unit tests that seed a pre-validated key directly into SQLite.
 */
export function addVaultKey(
  db: DatabaseSync,
  rawKey: string,
  projectLabel: string,
  options?: {
    keyType?: VaultKeyType;
    status?: VaultKeyStatus;
    lastCheckedAt?: string | null;
    lastError?: string | null;
    discoveredModels?: ModelDiscoveryResult | null;
    validationMessage?: string;
  }
): VaultKeyRecord {
  const trimmedKey = rawKey.trim();
  const trimmedLabel = projectLabel.trim() || 'Primary Gemini Key';
  if (trimmedKey.length < 10) {
    throw new Error('API key is too short. Please provide a valid API key.');
  }

  const keyHash = hashApiKey(trimmedKey);
  const encrypted = encryptApiKey(trimmedKey);
  const masked = maskApiKey(trimmedKey);
  const keyType: VaultKeyType = options?.keyType ?? 'GEMINI';
  const status: VaultKeyStatus = options?.status ?? 'VALID';
  const lastCheckedAt = options?.lastCheckedAt ?? new Date().toISOString();
  const lastError = options?.lastError ? sanitizeSecretMaterial(options.lastError) : null;
  const discoveredJson = options?.discoveredModels
    ? JSON.stringify(options.discoveredModels)
    : null;

  db.prepare(
    `INSERT INTO api_keys (
       key_hash, encrypted_key, masked_key, project_label, key_type, status,
       failure_count, cooldown_until, last_checked_at, last_error, discovered_models_json
     )
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
     ON CONFLICT(key_hash) DO UPDATE SET
       encrypted_key = excluded.encrypted_key,
       masked_key = excluded.masked_key,
       project_label = excluded.project_label,
       key_type = excluded.key_type,
       status = excluded.status,
       failure_count = 0,
       cooldown_until = NULL,
       last_checked_at = excluded.last_checked_at,
       last_error = excluded.last_error,
       discovered_models_json = COALESCE(excluded.discovered_models_json, api_keys.discovered_models_json)`
  ).run(
    keyHash,
    encrypted,
    masked,
    trimmedLabel,
    keyType,
    status,
    lastCheckedAt,
    lastError,
    discoveredJson
  );

  const row = db
    .prepare(
      `SELECT id, project_label, masked_key, key_type, status, cooldown_until, failure_count,
              last_used_at, last_checked_at, last_error, discovered_models_json, created_at
       FROM api_keys WHERE key_hash = ?`
    )
    .get(keyHash) as unknown as RawApiKeyRow;

  return mapKeyRow(row, options?.validationMessage);
}

/**
 * Validates a key live via `/v1beta/models` + 1-token `generateContent` and stores the outcome.
 * Invalid keys are stored with their diagnostic status (`INVALID_KEY`, `QUOTA_EXCEEDED`, etc.)
 * and are NOT activated.
 */
export async function validateAndAddVaultKey(
  db: DatabaseSync,
  rawKey: string,
  projectLabel: string,
  keyType: VaultKeyType = 'GEMINI',
  customFetch: typeof fetch = fetch
): Promise<VaultKeyRecord> {
  const outcome = await validateApiKeyLive(rawKey, keyType, customFetch);
  return addVaultKey(db, rawKey, projectLabel, {
    keyType,
    status: outcome.status,
    lastCheckedAt: outcome.lastCheckedAt,
    lastError: outcome.lastError,
    discoveredModels: outcome.discoveredModels,
    validationMessage: outcome.humanMessage,
  });
}

/**
 * Re-tests an existing stored key by ID and updates its `status`, `last_checked_at`, `last_error`,
 * and `discovered_models_json`.
 */
export async function testStoredVaultKey(
  db: DatabaseSync,
  keyId: number,
  customFetch: typeof fetch = fetch
): Promise<VaultKeyRecord> {
  const row = db
    .prepare(
      `SELECT id, project_label, masked_key, key_type, encrypted_key
       FROM api_keys WHERE id = ?`
    )
    .get(keyId) as
    | {
        id: number;
        project_label: string;
        masked_key: string;
        key_type: string;
        encrypted_key: string;
      }
    | undefined;

  if (!row) {
    const err = new Error(`API key #${keyId} not found in Vault.`) as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 404;
    err.code = 'KEY_NOT_FOUND';
    throw err;
  }

  const keyType: VaultKeyType = row.key_type === 'YOUTUBE' ? 'YOUTUBE' : 'GEMINI';
  const decrypted = decryptApiKey(row.encrypted_key, { db, keyId: row.id });
  const outcome = await validateApiKeyLive(decrypted, keyType, customFetch);

  db.prepare(
    `UPDATE api_keys
     SET status = ?,
         last_checked_at = ?,
         last_error = ?,
         discovered_models_json = COALESCE(?, discovered_models_json),
         cooldown_until = CASE WHEN ? = 'VALID' THEN NULL ELSE cooldown_until END
     WHERE id = ?`
  ).run(
    outcome.status,
    outcome.lastCheckedAt,
    outcome.lastError,
    outcome.discoveredModels ? JSON.stringify(outcome.discoveredModels) : null,
    outcome.status,
    row.id
  );

  const updated = db
    .prepare(
      `SELECT id, project_label, masked_key, key_type, status, cooldown_until, failure_count,
              last_used_at, last_checked_at, last_error, discovered_models_json, created_at
       FROM api_keys WHERE id = ?`
    )
    .get(row.id) as unknown as RawApiKeyRow;

  return mapKeyRow(updated, outcome.humanMessage);
}

export function deleteVaultKey(db: DatabaseSync, keyId: number): boolean {
  const res = db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(keyId);
  return res.changes > 0;
}

/**
 * Returns ordered candidate GEMINI keys that are currently `VALID` or `ACTIVE`,
 * decrypting each via `decryptApiKey`.
 */
export function getActiveDecryptedKeys(
  db: DatabaseSync,
  keyType: VaultKeyType = 'GEMINI'
): DecryptedKeyCandidate[] {
  releaseExpiredCooldownKeys(db);
  const rows = db
    .prepare(
      `SELECT id, project_label, masked_key, key_type, encrypted_key, discovered_models_json
       FROM api_keys
       WHERE status IN ('VALID', 'ACTIVE') AND COALESCE(key_type, 'GEMINI') = ?
       ORDER BY COALESCE(last_used_at, '1970-01-01') ASC, id ASC`
    )
    .all(keyType) as Array<{
    id: number;
    project_label: string;
    masked_key: string;
    key_type: string;
    encrypted_key: string;
    discovered_models_json: string | null;
  }>;

  const candidates: DecryptedKeyCandidate[] = [];
  for (const row of rows) {
    try {
      const apiKey = decryptApiKey(row.encrypted_key, { db, keyId: row.id });
      candidates.push({
        id: row.id,
        projectLabel: row.project_label,
        maskedKey: row.masked_key,
        keyType: row.key_type === 'YOUTUBE' ? 'YOUTUBE' : 'GEMINI',
        apiKey,
        discoveredModels: parseDiscoveredModels(row.discovered_models_json),
      });
    } catch {
      // Row is marked UNREADABLE inside decryptApiKey; continue to next key
    }
  }
  return candidates;
}

export function markKeyCooldown429(
  db: DatabaseSync,
  keyId: number,
  cooldownMs: number = COOLDOWN_429_MS
): string {
  const untilIso = new Date(Date.now() + cooldownMs).toISOString();
  db.prepare(
    `UPDATE api_keys
     SET status = 'COOLDOWN_429',
         cooldown_until = ?,
         last_checked_at = CURRENT_TIMESTAMP,
         last_error = 'Rate limit / HTTP 429 cooldown active',
         failure_count = failure_count + 1
     WHERE id = ?`
  ).run(untilIso, keyId);
  return untilIso;
}

export function markKeyInvalid(db: DatabaseSync, keyId: number, reason?: string): void {
  const cleanReason = reason
    ? sanitizeSecretMaterial(reason)
    : 'Key rejected by Gemini API (401/403)';
  db.prepare(
    `UPDATE api_keys
     SET status = 'INVALID_KEY',
         last_checked_at = CURRENT_TIMESTAMP,
         last_error = ?,
         failure_count = failure_count + 1
     WHERE id = ?`
  ).run(cleanReason, keyId);
}

export function markKeyUsedSuccess(db: DatabaseSync, keyId: number): void {
  db.prepare(
    `UPDATE api_keys
     SET status = 'VALID',
         cooldown_until = NULL,
         last_error = NULL,
         last_used_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(keyId);
}
