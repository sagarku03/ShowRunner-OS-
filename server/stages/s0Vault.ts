import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_WPM,
  type GenerationMode,
  type VideoProvider,
} from '../../src/config/constants.ts';
import { commitStageState } from '../fsm/machine.ts';
import {
  deleteVaultKey,
  getActiveDecryptedKeys,
  listVaultKeys,
  testStoredVaultKey,
  validateAndAddVaultKey,
  type VaultKeyRecord,
  type VaultKeyType,
} from '../llm/keyPool.ts';
import { fetchLiveGeminiModels, type ModelDiscoveryResult } from '../llm/models.ts';

export interface VaultConfigUpdateInput {
  brandName?: string;
  reasoningModel?: string;
  fastModel?: string;
  embeddingModel?: string;
  smartTiering?: boolean;
  generationMode?: GenerationMode;
  videoProvider?: VideoProvider;
  defaultClipDuration?: number;
  configuredWpm?: number;
  targetDuration?: number;
}

export interface LlmHealthStatus {
  activeKeys: number;
  validKeys: number;
  models: {
    reasoningModels: string[];
    fastModels: string[];
    embeddingModels: string[];
    recommendedReasoning: string | null;
    recommendedFast: string | null;
    recommendedEmbedding: string | null;
  };
  lastError: string | null;
}

export function handleListKeys(db: DatabaseSync): VaultKeyRecord[] {
  return listVaultKeys(db);
}

function syncProjectModelsFromDiscovery(
  db: DatabaseSync,
  projectId: string | null,
  discovery: ModelDiscoveryResult | null
): void {
  if (!discovery) return;
  if (projectId) {
    db.prepare(
      `UPDATE projects
       SET reasoning_model = COALESCE(reasoning_model, ?),
           fast_model = COALESCE(fast_model, ?),
           embedding_model = COALESCE(embedding_model, ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      discovery.recommendedReasoning,
      discovery.recommendedFast,
      discovery.recommendedEmbedding,
      projectId
    );
  } else {
    db.prepare(
      `UPDATE projects
       SET reasoning_model = COALESCE(reasoning_model, ?),
           fast_model = COALESCE(fast_model, ?),
           embedding_model = COALESCE(embedding_model, ?),
           updated_at = CURRENT_TIMESTAMP`
    ).run(
      discovery.recommendedReasoning,
      discovery.recommendedFast,
      discovery.recommendedEmbedding
    );
  }
}

export async function handleAddKey(
  db: DatabaseSync,
  projectId: string | null,
  rawKey: string,
  projectLabel: string,
  keyType: VaultKeyType = 'GEMINI',
  customFetch?: typeof fetch
): Promise<VaultKeyRecord> {
  const record = await validateAndAddVaultKey(
    db,
    rawKey,
    projectLabel,
    keyType,
    customFetch
  );

  if (record.status === 'VALID' && record.discoveredModels) {
    syncProjectModelsFromDiscovery(db, projectId, record.discoveredModels);
  }

  const validCount = listVaultKeys(db).filter(
    (k) => k.keyType === 'GEMINI' && (k.status === 'VALID' || k.status === 'ACTIVE')
  ).length;

  if (projectId && validCount > 0) {
    commitStageState(db, {
      projectId,
      stageId: 'S0',
      payload: {
        activeKeyCount: validCount,
        lastUpdatedKeyId: record.id,
      },
      status: 'PASSED',
    });
  }
  return record;
}

export async function handleTestKey(
  db: DatabaseSync,
  projectId: string | null,
  keyId: number,
  customFetch?: typeof fetch
): Promise<VaultKeyRecord> {
  const record = await testStoredVaultKey(db, keyId, customFetch);
  if (record.status === 'VALID' && record.discoveredModels) {
    syncProjectModelsFromDiscovery(db, projectId, record.discoveredModels);
  }
  return record;
}

export function handleDeleteKey(db: DatabaseSync, keyId: number): boolean {
  return deleteVaultKey(db, keyId);
}

export async function handleDiscoverModels(
  db: DatabaseSync,
  projectId: string | null,
  customFetch?: typeof fetch
): Promise<ModelDiscoveryResult> {
  const activeKeys = getActiveDecryptedKeys(db, 'GEMINI');
  if (activeKeys.length === 0) {
    const err = new Error(
      'Cannot discover models: no VALID Gemini API key in Vault. Add and test a key first.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 409;
    err.code = 'NO_ACTIVE_API_KEY';
    throw err;
  }

  const discovery = await fetchLiveGeminiModels(activeKeys[0].apiKey, customFetch);

  db.prepare(
    `UPDATE api_keys
     SET discovered_models_json = ?,
         last_checked_at = CURRENT_TIMESTAMP,
         last_error = NULL
     WHERE id = ?`
  ).run(JSON.stringify(discovery), activeKeys[0].id);

  syncProjectModelsFromDiscovery(db, projectId, discovery);
  return discovery;
}

export function handleGetLlmHealth(db: DatabaseSync): LlmHealthStatus {
  const keys = listVaultKeys(db).filter((k) => k.keyType === 'GEMINI');
  const validKeys = keys.filter((k) => k.status === 'VALID' || k.status === 'ACTIVE');

  const reasoningSet = new Set<string>();
  const fastSet = new Set<string>();
  const embeddingSet = new Set<string>();
  let recommendedReasoning: string | null = null;
  let recommendedFast: string | null = null;
  let recommendedEmbedding: string | null = null;

  for (const k of validKeys) {
    if (k.discoveredModels) {
      for (const m of k.discoveredModels.reasoningModels) reasoningSet.add(m.id);
      for (const m of k.discoveredModels.fastModels) fastSet.add(m.id);
      for (const m of k.discoveredModels.embeddingModels) embeddingSet.add(m.id);
      recommendedReasoning = recommendedReasoning || k.discoveredModels.recommendedReasoning;
      recommendedFast = recommendedFast || k.discoveredModels.recommendedFast;
      recommendedEmbedding = recommendedEmbedding || k.discoveredModels.recommendedEmbedding;
    }
  }

  const lastErrKey = [...keys]
    .reverse()
    .find((k) => typeof k.lastError === 'string' && k.lastError.trim().length > 0);

  return {
    activeKeys: keys.length,
    validKeys: validKeys.length,
    models: {
      reasoningModels: Array.from(reasoningSet),
      fastModels: Array.from(fastSet),
      embeddingModels: Array.from(embeddingSet),
      recommendedReasoning,
      recommendedFast,
      recommendedEmbedding,
    },
    lastError: lastErrKey?.lastError ?? null,
  };
}

export function handleUpdateVaultConfig(
  db: DatabaseSync,
  projectId: string,
  input: VaultConfigUpdateInput
): Record<string, unknown> {
  const current = db
    .prepare(
      `SELECT id, brand_name, reasoning_model, fast_model, embedding_model, smart_tiering,
              generation_mode, video_provider, default_clip_duration, configured_wpm, target_duration
       FROM projects WHERE id = ?`
    )
    .get(projectId) as
    | {
        id: string;
        brand_name: string | null;
        reasoning_model: string | null;
        fast_model: string | null;
        embedding_model: string | null;
        smart_tiering: number;
        generation_mode: GenerationMode;
        video_provider: VideoProvider;
        default_clip_duration: number;
        configured_wpm: number;
        target_duration: number;
      }
    | undefined;

  if (!current) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  const nextBrandName =
    typeof input.brandName === 'string' && input.brandName.trim()
      ? input.brandName.trim()
      : current.brand_name || 'FactLock';
  const nextReasoning = input.reasoningModel ?? current.reasoning_model;
  const nextFast = input.fastModel ?? current.fast_model;
  const nextEmbedding = input.embeddingModel ?? current.embedding_model;
  const nextSmart =
    typeof input.smartTiering === 'boolean' ? (input.smartTiering ? 1 : 0) : current.smart_tiering;
  const nextMode = input.generationMode ?? current.generation_mode;
  const nextProvider = input.videoProvider ?? current.video_provider;
  const nextClipDur =
    typeof input.defaultClipDuration === 'number'
      ? input.defaultClipDuration
      : current.default_clip_duration;
  const nextWpm =
    typeof input.configuredWpm === 'number' && input.configuredWpm > 40
      ? input.configuredWpm
      : current.configured_wpm || DEFAULT_WPM;
  const nextTargetDur =
    typeof input.targetDuration === 'number' && input.targetDuration >= 1
      ? input.targetDuration
      : current.target_duration || 10;

  const targetWords = Math.round(nextTargetDur * nextWpm);

  db.prepare(
    `UPDATE projects
     SET brand_name = ?,
         reasoning_model = ?,
         fast_model = ?,
         embedding_model = ?,
         smart_tiering = ?,
         generation_mode = ?,
         video_provider = ?,
         default_clip_duration = ?,
         configured_wpm = ?,
         target_duration = ?,
         target_words = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    nextBrandName,
    nextReasoning,
    nextFast,
    nextEmbedding,
    nextSmart,
    nextMode,
    nextProvider,
    nextClipDur,
    nextWpm,
    nextTargetDur,
    targetWords,
    projectId
  );

  const payload = {
    brandName: nextBrandName,
    reasoningModel: nextReasoning,
    fastModel: nextFast,
    embeddingModel: nextEmbedding,
    smartTiering: nextSmart === 1,
    generationMode: nextMode,
    videoProvider: nextProvider,
    defaultClipDuration: nextClipDur,
    configuredWpm: nextWpm,
    targetDuration: nextTargetDur,
    targetWords,
  };

  commitStageState(db, {
    projectId,
    stageId: 'S0',
    payload,
    status: 'PASSED',
  });

  return payload;
}
