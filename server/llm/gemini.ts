import { GoogleGenAI, type Schema } from '@google/genai';
import type { DatabaseSync } from 'node:sqlite';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  MAX_KEY_ROTATION_ATTEMPTS,
  type ModelTier,
} from '../../src/config/constants.ts';
import { logRedactedLlmCall, sanitizeSecretMaterial } from './errors.ts';
import {
  getActiveDecryptedKeys,
  markKeyCooldown429,
  markKeyInvalid,
  markKeyUsedSuccess,
  type DecryptedActiveKey,
} from './keyPool.ts';
import { fetchLiveGeminiModels, type ModelDiscoveryResult } from './models.ts';

export interface FailoverEvent {
  fromKeyId: number;
  fromLabel: string;
  toKeyId?: number;
  toLabel?: string;
  reason: string;
  cooldownUntil: string;
  toastMessage: string;
}

export interface GroundingChunkSource {
  uri: string;
  title: string;
}

export interface GroundedMarkdownRequest {
  db: DatabaseSync;
  projectId?: string | null;
  stage?: string;
  tier: ModelTier;
  systemInstruction: string;
  userPrompt: string;
  temperature?: number;
}

export interface GroundedMarkdownResponse {
  markdown: string;
  modelUsed: string;
  keyIdUsed: number;
  webSearchQueries: string[];
  groundingSources: GroundingChunkSource[];
}

export interface StructuredGenerationRequest<TSchema = Schema> {
  db: DatabaseSync;
  projectId?: string | null;
  stage?: string;
  tier: ModelTier;
  systemInstruction: string;
  userPrompt: string;
  responseSchema: TSchema;
  temperature?: number;
  fileUri?: string;
  fileMimeType?: string;
}

export interface StructuredGenerationResponse<T> {
  data: T;
  rawText: string;
  modelUsed: string;
  keyIdUsed: number;
}

export interface GeminiGateway {
  isFake?: boolean;
  mockFetch?: typeof fetch;
  generateGroundedMarkdown(
    req: GroundedMarkdownRequest
  ): Promise<GroundedMarkdownResponse>;
  generateStructured<T>(
    req: StructuredGenerationRequest
  ): Promise<StructuredGenerationResponse<T>>;
  embedTexts(params: {
    db: DatabaseSync;
    projectId?: string | null;
    stage?: string;
    texts: string[];
  }): Promise<{ vectors: number[][]; modelUsed: string; keyIdUsed: number }>;
}

function isRateLimitOrTransientError(err: unknown): boolean {
  const msg = ((err as Error)?.message || String(err)).toLowerCase();
  const status = (err as { status?: number })?.status;
  return (
    status === 429 ||
    status === 503 ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded')
  );
}

function isAuthError(err: unknown): boolean {
  const msg = ((err as Error)?.message || String(err)).toLowerCase();
  const status = (err as { status?: number })?.status;
  return (
    status === 401 ||
    status === 403 ||
    msg.includes('api_key_invalid') ||
    msg.includes('invalid api key') ||
    msg.includes('permission_denied')
  );
}

function sleepWithJitter(attempt: number): Promise<void> {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * 120);
  return new Promise((resolve) => setTimeout(resolve, Math.min(250, exp + jitter)));
}

function createNoUsableModelError(tier: ModelTier, detail?: string): Error & {
  code: string;
  statusCode: number;
} {
  const extra = detail ? ` (${sanitizeSecretMaterial(detail)})` : '';
  const err = new Error(
    `No usable model available for tier ${tier}${extra}. Open Vault → Test key → pick a model.`
  ) as Error & { code: string; statusCode: number };
  err.code = 'NO_USABLE_MODEL';
  err.statusCode = 422;
  return err;
}

function pickFromDiscovery(discovery: ModelDiscoveryResult, tier: ModelTier): string | null {
  if (tier === 'TIER_EMBEDDING') {
    return discovery.recommendedEmbedding || discovery.embeddingModels[0]?.id || null;
  }
  if (tier === 'TIER_REASONING') {
    return (
      discovery.recommendedReasoning ||
      discovery.reasoningModels[0]?.id ||
      discovery.recommendedFast ||
      discovery.fastModels[0]?.id ||
      null
    );
  }
  return (
    discovery.recommendedFast ||
    discovery.fastModels[0]?.id ||
    discovery.recommendedReasoning ||
    discovery.reasoningModels[0]?.id ||
    null
  );
}

/**
 * Resolves the model ID for a given project and tier.
 * Zero hard-coded model fallbacks: if no model is selected on the project or discovered for `tier`,
 * throws typed `NO_USABLE_MODEL` with hint `"Open Vault → Test key → pick a model"`.
 */
export function resolveModelForProjectTier(
  db: DatabaseSync,
  projectId: string | null | undefined,
  tier: ModelTier
): string {
  let effectiveTier: ModelTier = tier;

  if (projectId) {
    const row = db
      .prepare(
        `SELECT reasoning_model, fast_model, embedding_model, smart_tiering FROM projects WHERE id = ?`
      )
      .get(projectId) as
      | {
          reasoning_model: string | null;
          fast_model: string | null;
          embedding_model: string | null;
          smart_tiering: number;
        }
      | undefined;

    if (row) {
      effectiveTier =
        row.smart_tiering === 0 && tier === 'TIER_FAST' ? 'TIER_REASONING' : tier;
      if (effectiveTier === 'TIER_REASONING' && row.reasoning_model?.trim()) {
        return row.reasoning_model.trim();
      }
      if (effectiveTier === 'TIER_FAST' && row.fast_model?.trim()) {
        return row.fast_model.trim();
      }
      if (effectiveTier === 'TIER_EMBEDDING' && row.embedding_model?.trim()) {
        return row.embedding_model.trim();
      }
      throw createNoUsableModelError(
        effectiveTier,
        'No model selected for this project tier'
      );
    }
  }

  // Fallback for project-less calls: check cached discovered models in api_keys
  const cachedKeyRows = db
    .prepare(
      `SELECT discovered_models_json FROM api_keys
       WHERE status IN ('VALID', 'ACTIVE') AND discovered_models_json IS NOT NULL
       ORDER BY id ASC`
    )
    .all() as Array<{ discovered_models_json: string }>;

  for (const r of cachedKeyRows) {
    try {
      const parsed = JSON.parse(r.discovered_models_json) as ModelDiscoveryResult;
      const picked = pickFromDiscovery(parsed, effectiveTier);
      if (picked) return picked;
    } catch {
      // Ignore corrupt cache
    }
  }

  throw createNoUsableModelError(effectiveTier, 'Discovered model list for tier is empty');
}

export async function executeWithKeyFailover<T>(params: {
  db: DatabaseSync;
  onFailover?: (ev: FailoverEvent) => void;
  operation: (apiKey: string, keyRecord: DecryptedActiveKey) => Promise<T>;
}): Promise<{ result: T; keyUsed: DecryptedActiveKey }> {
  const { db, onFailover, operation } = params;
  const activeKeys = getActiveDecryptedKeys(db, 'GEMINI');

  if (activeKeys.length === 0) {
    const err = new Error(
      'No VALID Gemini API keys available in the Vault. Add and test a key in Stage 0.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 409;
    err.code = 'NO_ACTIVE_API_KEY';
    throw err;
  }

  const maxAttempts = Math.min(MAX_KEY_ROTATION_ATTEMPTS, activeKeys.length);
  let lastError: unknown;

  for (let i = 0; i < maxAttempts; i++) {
    const currentKey = activeKeys[i];
    try {
      const result = await operation(currentKey.apiKey, currentKey);
      markKeyUsedSuccess(db, currentKey.id);
      return { result, keyUsed: currentKey };
    } catch (err) {
      lastError = err;
      if (isRateLimitOrTransientError(err)) {
        const cooldownUntil = markKeyCooldown429(db, currentKey.id);
        const nextKey = activeKeys[i + 1];
        const nextLabel = nextKey?.projectLabel || 'Backup Key';
        onFailover?.({
          fromKeyId: currentKey.id,
          fromLabel: currentKey.projectLabel,
          toKeyId: nextKey?.id,
          toLabel: nextKey?.projectLabel,
          reason: sanitizeSecretMaterial((err as Error)?.message || 'HTTP 429 / Quota Exhausted'),
          cooldownUntil,
          toastMessage: `⚠️ ${currentKey.projectLabel} Limit Reached. Auto-switched to ${nextLabel}. Pipeline continuing seamlessly.`,
        });
        if (i + 1 < maxAttempts) {
          await sleepWithJitter(i);
          continue;
        }
      } else if (isAuthError(err)) {
        const rawReason = sanitizeSecretMaterial((err as Error)?.message || 'HTTP 401/403');
        markKeyInvalid(db, currentKey.id, rawReason);
        const authErr = new Error(
          `Key ${currentKey.projectLabel} rejected: ${rawReason}`
        ) as Error & { code?: string; statusCode?: number };
        authErr.code = 'INVALID_KEY';
        authErr.statusCode = 401;
        lastError = authErr;
        if (i + 1 < maxAttempts) {
          continue;
        }
      } else {
        throw err;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`All ${maxAttempts} API key rotation attempts failed.`);
}

export function createGeminiGateway(options?: {
  onFailover?: (ev: FailoverEvent) => void;
  customFetch?: typeof fetch;
}): GeminiGateway {
  const customFetch = options?.customFetch ?? fetch;

  return {
    async generateGroundedMarkdown(
      req: GroundedMarkdownRequest
    ): Promise<GroundedMarkdownResponse> {
      const {
        db,
        projectId,
        stage = 'S2',
        tier,
        systemInstruction,
        userPrompt,
        temperature = 0.2,
      } = req;
      const startedAt = Date.now();

      const { result, keyUsed } = await executeWithKeyFailover({
        db,
        onFailover: options?.onFailover,
        operation: async (apiKey, keyRec) => {
          const modelName = resolveModelForProjectTier(
            db,
            projectId,
            tier
          );
          try {
            const ai = new GoogleGenAI({ apiKey });
            const response = await ai.models.generateContent({
              model: modelName,
              contents: userPrompt,
              config: {
                systemInstruction,
                tools: [{ googleSearch: {} }],
                temperature,
              },
            });

            const markdown = (response.text || '').trim();
            const candidate = response.candidates?.[0];
            const groundingMeta = candidate?.groundingMetadata;

            const webSearchQueries: string[] = Array.isArray(groundingMeta?.webSearchQueries)
              ? groundingMeta.webSearchQueries.map(String)
              : [];

            const groundingSources: GroundingChunkSource[] = [];
            const chunks = groundingMeta?.groundingChunks;
            if (Array.isArray(chunks)) {
              for (const ch of chunks) {
                const uri = ch?.web?.uri;
                const title = ch?.web?.title || uri || 'Grounded Source';
                if (typeof uri === 'string' && uri.trim().length > 0) {
                  groundingSources.push({ uri: uri.trim(), title: String(title).trim() });
                }
              }
            }

            logRedactedLlmCall({
              stage,
              tier,
              model: modelName,
              keyLabel: keyRec.projectLabel,
              latencyMs: Date.now() - startedAt,
              outcome: 'OK_GROUNDED',
            });

            return {
              markdown,
              modelName,
              webSearchQueries,
              groundingSources,
            };
          } catch (err) {
            logRedactedLlmCall({
              stage,
              tier,
              model: modelName,
              keyLabel: keyRec.projectLabel,
              latencyMs: Date.now() - startedAt,
              outcome: `ERR: ${(err as Error)?.message || 'unknown'}`,
            });
            throw err;
          }
        },
      });

      return {
        markdown: result.markdown,
        modelUsed: result.modelName,
        keyIdUsed: keyUsed.id,
        webSearchQueries: result.webSearchQueries,
        groundingSources: result.groundingSources,
      };
    },

    async generateStructured<T>(
      req: StructuredGenerationRequest
    ): Promise<StructuredGenerationResponse<T>> {
      const {
        db,
        projectId,
        stage = 'STRUCTURED',
        tier,
        systemInstruction,
        userPrompt,
        responseSchema,
        temperature = 0.3,
        fileUri,
        fileMimeType,
      } = req;
      const startedAt = Date.now();

      const { result, keyUsed } = await executeWithKeyFailover({
        db,
        onFailover: options?.onFailover,
        operation: async (apiKey, keyRec) => {
          const modelName = resolveModelForProjectTier(
            db,
            projectId,
            tier
          );
          try {
            const ai = new GoogleGenAI({ apiKey });
            const contents = fileUri
              ? [
                  {
                    role: 'user',
                    parts: [
                      {
                        fileData: {
                          fileUri,
                          mimeType: fileMimeType || 'video/*',
                        },
                      },
                      { text: userPrompt },
                    ],
                  },
                ]
              : userPrompt;

            const response = await ai.models.generateContent({
              model: modelName,
              contents,
              config: {
                systemInstruction,
                responseMimeType: 'application/json',
                responseSchema,
                temperature,
              },
            });

            const rawText = (response.text || '').trim();
            if (!rawText) {
              const emptyErr = new Error(
                `Gemini model "${modelName}" returned an empty response.`
              ) as Error & { code?: string; statusCode?: number };
              emptyErr.code = 'EMPTY_LLM_RESPONSE';
              emptyErr.statusCode = 502;
              throw emptyErr;
            }
            const parsed = JSON.parse(rawText) as T;

            logRedactedLlmCall({
              stage,
              tier,
              model: modelName,
              keyLabel: keyRec.projectLabel,
              latencyMs: Date.now() - startedAt,
              outcome: 'OK_STRUCTURED',
            });

            return { parsed, rawText, modelName };
          } catch (err) {
            logRedactedLlmCall({
              stage,
              tier,
              model: modelName,
              keyLabel: keyRec.projectLabel,
              latencyMs: Date.now() - startedAt,
              outcome: `ERR: ${(err as Error)?.message || 'unknown'}`,
            });
            throw err;
          }
        },
      });

      return {
        data: result.parsed,
        rawText: result.rawText,
        modelUsed: result.modelName,
        keyIdUsed: keyUsed.id,
      };
    },

    async embedTexts(params): Promise<{
      vectors: number[][];
      modelUsed: string;
      keyIdUsed: number;
    }> {
      const { db, projectId, stage = 'EMBED', texts } = params;
      const startedAt = Date.now();

      const { result, keyUsed } = await executeWithKeyFailover({
        db,
        onFailover: options?.onFailover,
        operation: async (apiKey, keyRec) => {
          const modelName = resolveModelForProjectTier(
            db,
            projectId,
            'TIER_EMBEDDING'
          );
          try {
            const ai = new GoogleGenAI({ apiKey });
            const vectors: number[][] = [];
            for (const text of texts) {
              const res = await ai.models.embedContent({
                model: modelName,
                contents: text,
              });
              const values = res.embeddings?.[0]?.values;
              if (!values || values.length === 0) {
                const err = new Error(
                  `Embedding model "${modelName}" returned empty vector.`
                ) as Error & { code?: string; statusCode?: number };
                err.code = 'NO_USABLE_MODEL';
                err.statusCode = 422;
                throw err;
              }
              vectors.push(values);
            }

            logRedactedLlmCall({
              stage,
              tier: 'TIER_EMBEDDING',
              model: modelName,
              keyLabel: keyRec.projectLabel,
              latencyMs: Date.now() - startedAt,
              outcome: `OK_EMBED(${texts.length})`,
            });

            return { vectors, modelName };
          } catch (err) {
            logRedactedLlmCall({
              stage,
              tier: 'TIER_EMBEDDING',
              model: modelName,
              keyLabel: keyRec.projectLabel,
              latencyMs: Date.now() - startedAt,
              outcome: `ERR: ${(err as Error)?.message || 'unknown'}`,
            });
            throw err;
          }
        },
      });

      return {
        vectors: result.vectors,
        modelUsed: result.modelName,
        keyIdUsed: keyUsed.id,
      };
    },
  };
}
