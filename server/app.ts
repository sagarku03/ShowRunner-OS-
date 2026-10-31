import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import {
  DEFAULT_WPM,
  NEUTRAL_CAMERA_MOTION,
  NEUTRAL_LIGHTING,
  NEUTRAL_PALETTE,
  NEUTRAL_STYLE_PREFIX,
  type DurationPresetChip,
  type GenerationMode,
  type StageId,
  type VideoProvider,
} from '../src/config/constants.ts';
import type { RuntimeConfig } from '../src/config/runtime.ts';
import { getStageRow, StageGateError } from './fsm/gates.ts';
import { invalidateDownstreamStages } from './fsm/invalidation.ts';
import { commitStageState, getPipelineStateVector } from './fsm/machine.ts';
import { mapGeminiError } from './llm/errors.ts';
import {
  createGeminiGateway,
  type FailoverEvent,
  type GeminiGateway,
} from './llm/gemini.ts';
import { syncPreviewSecretKeyIfPresent } from './llm/keyPool.ts';
import { createOriginGuardMiddleware } from './security/origin.ts';
import { createBearerAuthMiddleware } from './security/token.ts';
import { VaultDecryptionError } from './security/vault.ts';
import {
  detectLanguageAndScript,
  parseExpressTranscript,
  stripAndCollectNonSpeechTokens,
  type DetectedTimeUnit,
} from '../shared/rules/transcript.ts';
import {
  getMasterPromptState,
  handleSaveMasterPrompt,
  type MasterPromptExtraction,
} from './stages/s0MasterPrompt.ts';
import {
  handleAddKey,
  handleDeleteKey,
  handleDiscoverModels,
  handleGetLlmHealth,
  handleListKeys,
  handleTestKey,
  handleUpdateVaultConfig,
} from './stages/s0Vault.ts';
import {
  getLockedChannelDna,
  handleAnalyseExistingChannelDna,
  handleAnalyseNicheDna,
  handleAnalyseReferenceChannelsDna,
  handleLockChannelDna,
  handleUnlockChannelDna,
  normalizeChannelDnaObject,
  type ChannelDnaRecord,
} from './stages/s0bChannelDna.ts';
import {
  addBlacklistEntry,
  handleEvaluateCustomTopic,
  handleGenerateTopics,
  handleLockTopic,
  listBlacklistEntries,
} from './stages/s1Topics.ts';
import {
  handleApproveResearch,
  handleRunResearch,
  handleUpdateEvidence,
} from './stages/s2Research.ts';
import {
  handleBuildArchitecture,
  handleUpdateRuntimeChapters,
} from './stages/s3Arch.ts';
import {
  handleAuditExistingScript,
  handleGenerateAndAuditScript,
  handleSurgicalRepairEndpoint,
} from './stages/s4Script.ts';
import {
  handleAudioSyncAndSlice,
  handleBuildStoryboard,
  handleLockTranscript,
  handleRollbackTranscriptDrift,
} from './stages/s5Audio.ts';
import {
  handleGenerateVisualPrompts,
  type Stage6PromptsPayload,
} from './stages/s6Prompts.ts';
import {
  buildMasterExportZip,
  handleGeneratePackaging,
  handleSelectPackagingPack,
} from './stages/s7Export.ts';

export interface CreateAppOptions {
  db: DatabaseSync;
  runtime: RuntimeConfig;
  expectedToken: string;
  gemini?: GeminiGateway;
  customFetch?: typeof fetch;
  onBroadcast?: (event: { type: string; payload: unknown }) => void;
}

export interface ProjectSummary {
  id: string;
  name: string;
  niche: string;
  brandName: string;
  lockedTopic: string | null;
  targetDuration: number;
  targetWords: number;
  configuredWpm: number;
  actualWpm: number | null;
  activeState: StageId;
  generationMode: GenerationMode;
  videoProvider: VideoProvider;
  defaultClipDuration: number;
  reasoningModel: string | null;
  fastModel: string | null;
  embeddingModel: string | null;
  smartTiering: boolean;
  masterPrompt: string | null;
  masterPromptExtracted: MasterPromptExtraction | null;
  dnaVersion: number | null;
  entryMode: 'FULL' | 'EXPRESS';
  epoch: number;
  createdAt: string;
  updatedAt: string;
}

const defaultFakeKeyFetch: typeof fetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  if (url.includes('/v1beta/models') && (!init?.method || init.method === 'GET')) {
    return new Response(
      JSON.stringify({
        models: [
          {
            name: 'models/gemini-pro-latest',
            displayName: 'Gemini Pro Latest',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-flash-latest',
            displayName: 'Gemini Flash Latest',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-embedding-exp',
            displayName: 'Gemini Embedding Exp',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (url.includes(':generateContent')) {
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'OK' }] } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (url.includes('googleapis.com/youtube/v3/channels')) {
    return new Response(
      JSON.stringify({
        items: [{ id: 'UC_TEST_CHANNEL_01', snippet: { title: 'Test Channel' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

function mapProjectRow(row: Record<string, unknown>): ProjectSummary {
  let masterPromptExtracted: MasterPromptExtraction | null = null;
  if (typeof row.master_prompt_extracted_json === 'string' && row.master_prompt_extracted_json) {
    try {
      masterPromptExtracted = JSON.parse(row.master_prompt_extracted_json) as MasterPromptExtraction;
    } catch {
      masterPromptExtracted = null;
    }
  }

  return {
    id: String(row.id),
    name: String(row.name),
    niche: String(row.niche),
    brandName: String(row.brand_name ?? 'FactLock'),
    lockedTopic: row.locked_topic ? String(row.locked_topic) : null,
    targetDuration: Number(row.target_duration ?? 11),
    targetWords: Number(row.target_words ?? 2062),
    configuredWpm: Number(row.configured_wpm ?? DEFAULT_WPM),
    actualWpm:
      row.actual_wpm !== null && row.actual_wpm !== undefined ? Number(row.actual_wpm) : null,
    activeState: (row.active_state as StageId) ?? 'S0',
    generationMode: (String(row.generation_mode ?? 'MODE_2_VIDEO') as GenerationMode),
    videoProvider: (String(row.video_provider ?? 'VEO_3_1') as VideoProvider),
    defaultClipDuration: Number(row.default_clip_duration ?? 8),
    reasoningModel: row.reasoning_model ? String(row.reasoning_model) : null,
    fastModel: row.fast_model ? String(row.fast_model) : null,
    embeddingModel: row.embedding_model ? String(row.embedding_model) : null,
    smartTiering: Number(row.smart_tiering ?? 1) === 1,
    masterPrompt: row.master_prompt ? String(row.master_prompt) : null,
    masterPromptExtracted,
    dnaVersion:
      row.dna_version !== null && row.dna_version !== undefined
        ? Number(row.dna_version)
        : null,
    entryMode: String(row.entry_mode ?? 'FULL') === 'EXPRESS' ? 'EXPRESS' : 'FULL',
    epoch: Number(row.epoch ?? 1),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

function resolveActiveProjectId(db: DatabaseSync, req: Request): string | null {
  const fromHeader = req.headers['x-project-id'];
  if (typeof fromHeader === 'string' && fromHeader.trim()) {
    return fromHeader.trim();
  }
  if (typeof req.query.projectId === 'string' && req.query.projectId.trim()) {
    return req.query.projectId.trim();
  }
  if (
    req.body &&
    typeof req.body === 'object' &&
    typeof (req.body as Record<string, unknown>).projectId === 'string' &&
    String((req.body as Record<string, unknown>).projectId).trim()
  ) {
    return String((req.body as Record<string, unknown>).projectId).trim();
  }

  const latest = db
    .prepare(`SELECT id FROM projects ORDER BY updated_at DESC LIMIT 1`)
    .get() as { id: string } | undefined;
  return latest?.id ?? null;
}

function requireProjectId(db: DatabaseSync, req: Request): string {
  const id = resolveActiveProjectId(db, req);
  if (!id) {
    const err = new Error(
      'No project exists yet. Create a project first via POST /api/v1/projects.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 409;
    err.code = 'NO_PROJECT_SELECTED';
    throw err;
  }
  const exists = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id) as
    | { id: string }
    | undefined;
  if (!exists) {
    const err = new Error(`Project "${id}" was not found.`) as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 404;
    err.code = 'PROJECT_NOT_FOUND';
    throw err;
  }
  return id;
}

function createJobRecord(
  db: DatabaseSync,
  projectId: string,
  stageId: string,
  phase = 'STARTING',
  onBroadcast?: (event: { type: string; payload: unknown }) => void
): string {
  const jobId = `job-${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(
    `INSERT INTO jobs (id, project_id, stage_id, status, progress_pct, phase, message)
     VALUES (?, ?, ?, 'RUNNING', 10, ?, ?)`
  ).run(jobId, projectId, stageId, phase, `Executing stage ${stageId}...`);
  onBroadcast?.({
    type: 'JOB_PROGRESS',
    payload: { jobId, projectId, stageId, status: 'RUNNING', progressPct: 10, phase },
  });
  return jobId;
}

function updateJobProgress(
  db: DatabaseSync,
  jobId: string,
  stageId: string,
  progressPct: number,
  phase: string,
  message: string,
  onBroadcast?: (event: { type: string; payload: unknown }) => void
): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'RUNNING', progress_pct = ?, phase = ?, message = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(progressPct, phase, message, jobId);
  onBroadcast?.({
    type: 'JOB_PROGRESS',
    payload: { jobId, stageId, status: 'RUNNING', progressPct, phase, message },
  });
}

function finishJobRecord(
  db: DatabaseSync,
  jobId: string,
  stageId: string,
  result: unknown,
  onBroadcast?: (event: { type: string; payload: unknown }) => void
): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'DONE', progress_pct = 100, phase = 'COMPLETED', message = 'Completed', result_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(JSON.stringify(result), jobId);
  onBroadcast?.({
    type: 'JOB_DONE',
    payload: { jobId, stageId, status: 'DONE', progressPct: 100, phase: 'COMPLETED', result },
  });
}

function failJobRecord(
  db: DatabaseSync,
  jobId: string,
  stageId: string,
  err: unknown,
  onBroadcast?: (event: { type: string; payload: unknown }) => void
): void {
  const mapped = mapGeminiError(err);
  db.prepare(
    `UPDATE jobs
     SET status = 'FAILED', phase = 'FAILED', message = ?, error_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(mapped.userMessage, JSON.stringify(mapped), jobId);
  onBroadcast?.({
    type: 'JOB_ERROR',
    payload: { jobId, stageId, status: 'FAILED', phase: 'FAILED', error: mapped },
  });
}

function shouldRunDetachedAsync(req: Request): boolean {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.async === true || req.query.async === '1' || req.query.async === 'true') {
    return true;
  }
  const prefer = String(req.headers['prefer'] ?? '').toLowerCase();
  return prefer.includes('respond-async');
}

export function createShowRunnerApp(options: CreateAppOptions): Express {
  const { db, runtime, expectedToken, customFetch, onBroadcast } = options;

  const isFakeGemini = Boolean(
    options.gemini && (options.gemini as { isFake?: boolean }).isFake
  );
  const effectiveFetch: typeof fetch =
    customFetch ?? (isFakeGemini ? defaultFakeKeyFetch : fetch);

  syncPreviewSecretKeyIfPresent(db, runtime.mode);

  const notifyFailover = (ev: FailoverEvent): void => {
    onBroadcast?.({ type: 'KEY_FAILOVER', payload: ev });
  };

  const gemini: GeminiGateway =
    options.gemini ?? createGeminiGateway({ onFailover: notifyFailover });

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(createOriginGuardMiddleware(runtime.mode));

  // Public runtime info endpoint (does NOT leak bearer token)
  app.get('/api/v1/runtime', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      data: {
        mode: runtime.mode,
        showPreviewBanner: runtime.showPreviewBanner,
        requireBearerAuth: runtime.requireBearerAuth,
      },
    });
  });

  // Protect all /api/v1/* endpoints with Bearer token middleware when requireBearerAuth is true
  app.use(
    '/api/v1',
    createBearerAuthMiddleware({
      expectedToken,
      requireBearerAuth: runtime.requireBearerAuth,
    })
  );

  // ============================================================================
  // LLM HEALTH CHECK (Part A1)
  // ============================================================================
  app.get('/api/v1/health/llm', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const health = handleGetLlmHealth(db);
      res.json({ ok: true, data: health });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // ASYNC JOBS POLLING (Part A6)
  // ============================================================================
  app.get('/api/v1/jobs/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobId = String(req.params.id ?? '').trim();
      const row = db
        .prepare(
          `SELECT id, project_id, stage_id, status, progress_pct, phase, message, result_json, error_json, created_at, updated_at
           FROM jobs WHERE id = ?`
        )
        .get(jobId) as
        | {
            id: string;
            project_id: string;
            stage_id: string;
            status: string;
            progress_pct: number;
            phase: string | null;
            message: string | null;
            result_json: string | null;
            error_json: string | null;
            created_at: string;
            updated_at: string;
          }
        | undefined;

      if (!row) {
        res.status(404).json({
          ok: false,
          error: {
            code: 'JOB_NOT_FOUND',
            httpStatus: 404,
            message: `Job "${jobId}" not found.`,
            userMessage: `Job "${jobId}" not found.`,
            retryable: false,
          },
        });
        return;
      }

      res.json({
        ok: true,
        data: {
          id: row.id,
          jobId: row.id,
          projectId: row.project_id,
          stageId: row.stage_id,
          status: row.status,
          progressPct: row.progress_pct,
          phase: row.phase ?? (row.status === 'DONE' ? 'COMPLETED' : row.status),
          message: row.message,
          result: row.result_json ? JSON.parse(row.result_json) : null,
          error: row.error_json ? JSON.parse(row.error_json) : null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // PROJECTS MANAGEMENT
  // ============================================================================
  app.get('/api/v1/projects', (_req: Request, res: Response) => {
    const rows = db
      .prepare(`SELECT * FROM projects ORDER BY updated_at DESC`)
      .all() as Array<Record<string, unknown>>;
    res.json({
      ok: true,
      data: {
        projects: rows.map(mapProjectRow),
      },
    });
  });

  app.post('/api/v1/projects', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = String(body.name ?? '').trim();
      const niche = String(body.niche ?? '').trim();
      if (!name || !niche) {
        res.status(400).json({
          ok: false,
          error: {
            code: 'INVALID_PROJECT_INPUT',
            httpStatus: 400,
            message: 'Both project name and channel niche are required.',
            userMessage: 'Both project name and channel niche are required.',
            retryable: false,
          },
        });
        return;
      }

      const id =
        typeof body.id === 'string' && body.id.trim()
          ? body.id.trim()
          : `proj-${crypto.randomUUID().slice(0, 8)}`;
      const brandName =
        typeof body.brandName === 'string' && body.brandName.trim()
          ? body.brandName.trim()
          : 'FactLock';
      const targetDuration = Math.max(1, Number(body.targetDuration ?? 11));
      const configuredWpm = Math.max(60, Number(body.configuredWpm ?? DEFAULT_WPM));
      const targetWords = Math.round(targetDuration * configuredWpm);
      const generationMode = String(body.generationMode ?? 'MODE_2_VIDEO');
      const videoProvider = String(body.videoProvider ?? 'VEO_3_1');
      const defaultClipDuration = Number(body.defaultClipDuration ?? 8);
      const masterPrompt = body.masterPrompt ? String(body.masterPrompt).trim() : null;

      // Auto-populate discovered models from any existing VALID key unless explicitly disabled
      let reasoningModel =
        typeof body.reasoningModel === 'string' ? body.reasoningModel.trim() : null;
      let fastModel = typeof body.fastModel === 'string' ? body.fastModel.trim() : null;
      let embeddingModel =
        typeof body.embeddingModel === 'string' ? body.embeddingModel.trim() : null;

      if (body.autoSelectDiscoveredModels !== false) {
        const health = handleGetLlmHealth(db);
        if (!reasoningModel && health.models.reasoningModels.length > 0) {
          reasoningModel = health.models.reasoningModels[0];
        }
        if (!fastModel && health.models.fastModels.length > 0) {
          fastModel = health.models.fastModels[0];
        }
        if (!embeddingModel && health.models.embeddingModels.length > 0) {
          embeddingModel = health.models.embeddingModels[0];
        }
      }

      const entryMode =
        String(body.entryMode ?? body.mode ?? 'FULL').toUpperCase() === 'EXPRESS'
          ? 'EXPRESS'
          : 'FULL';

      db.prepare(
        `INSERT INTO projects (
           id, name, niche, brand_name, target_duration, target_words, configured_wpm,
           active_state, generation_mode, video_provider, default_clip_duration,
           reasoning_model, fast_model, embedding_model, master_prompt, entry_mode, epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'S0', ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(
        id,
        name,
        niche,
        brandName,
        targetDuration,
        targetWords,
        configuredWpm,
        generationMode,
        videoProvider,
        defaultClipDuration,
        reasoningModel,
        fastModel,
        embeddingModel,
        masterPrompt,
        entryMode
      );

      if (entryMode === 'EXPRESS') {
        for (const stg of ['S1', 'S2', 'S2.5', 'S3'] as const) {
          db.prepare(
            `INSERT OR REPLACE INTO project_stages (project_id, stage_id, payload_json, payload_hash, status, is_dirty, updated_at)
             VALUES (?, ?, '{}', 'external', 'EXTERNAL_PROVIDED', 0, CURRENT_TIMESTAMP)`
          ).run(id, stg);
        }
      }

      const validKeyCount = handleListKeys(db).filter(
        (k) => (k.status === 'VALID' || k.status === 'ACTIVE') && k.keyType === 'GEMINI'
      ).length;
      if (validKeyCount > 0) {
        commitStageState(db, {
          projectId: id,
          stageId: 'S0',
          payload: { activeKeyCount: validKeyCount, brandName },
          status: 'PASSED',
        });
      }

      const created = db
        .prepare(`SELECT * FROM projects WHERE id = ?`)
        .get(id) as Record<string, unknown>;

      res.status(201).json({
        ok: true,
        data: {
          project: mapProjectRow(created),
          stateVector: getPipelineStateVector(db, id),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/projects/:id/entry-mode', (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '').trim();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const nextMode = String(body.entryMode ?? body.mode ?? 'FULL').toUpperCase() === 'EXPRESS' ? 'EXPRESS' : 'FULL';

      db.prepare(`UPDATE projects SET entry_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nextMode, id);

      if (nextMode === 'FULL') {
        db.prepare(
          `DELETE FROM project_stages WHERE project_id = ? AND stage_id IN ('S1', 'S2', 'S2.5', 'S3') AND status = 'EXTERNAL_PROVIDED'`
        ).run(id);
        db.prepare(
          `UPDATE project_stages SET is_dirty = 1, status = 'DIRTY', updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND stage_id IN ('S4', 'S5', 'S6', 'S7')`
        ).run(id);
      } else {
        for (const stg of ['S1', 'S2', 'S2.5', 'S3'] as const) {
          const cur = getStageRow(db, id, stg);
          db.prepare(
            `INSERT OR REPLACE INTO project_stages (project_id, stage_id, payload_json, payload_hash, status, is_dirty, updated_at)
             VALUES (?, ?, ?, 'external', 'EXTERNAL_PROVIDED', 0, CURRENT_TIMESTAMP)`
          ).run(id, stg, cur?.payload_json || '{}');
        }
        db.prepare(
          `UPDATE project_stages SET is_dirty = 1, status = 'DIRTY', updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND stage_id IN ('S5', 'S6', 'S7')`
        ).run(id);
      }

      const updated = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown>;
      res.json({
        ok: true,
        data: {
          project: mapProjectRow(updated),
          stateVector: getPipelineStateVector(db, id),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/v1/projects/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '').trim();
      const result = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
      res.json({
        ok: true,
        data: { deleted: result.changes > 0, id },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // STAGE 0 — VAULT, LIVE KEY VALIDATION & MODEL DISCOVERY (Part A1)
  // ============================================================================
  app.get('/api/v1/vault/keys', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const keys = handleListKeys(db);
      res.json({ ok: true, data: { keys } });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/vault/keys', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawKey = String(body.apiKey ?? body.key ?? '').trim();
      const label = String(body.projectLabel ?? body.label ?? 'Primary Gemini Key').trim();
      const keyType =
        String(body.keyType ?? 'GEMINI').toUpperCase() === 'YOUTUBE' ? 'YOUTUBE' : 'GEMINI';
      const projectId = resolveActiveProjectId(db, req);
      const record = await handleAddKey(
        db,
        projectId,
        rawKey,
        label,
        keyType,
        effectiveFetch
      );
      res.status(201).json({
        ok: true,
        data: {
          key: record,
          valid: record.status === 'VALID',
          message:
            record.status === 'VALID'
              ? `Key "${record.projectLabel}" verified and activated.`
              : record.lastError ?? `Key "${record.projectLabel}" failed validation (${record.status}).`,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/v1/vault/keys/:id/test',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const keyId = Number(req.params.id);
        const projectId = resolveActiveProjectId(db, req);
        const record = await handleTestKey(db, projectId, keyId, effectiveFetch);
        res.json({
          ok: true,
          data: {
            key: record,
            valid: record.status === 'VALID',
            discoveredModels: record.discoveredModels,
            message:
              record.status === 'VALID'
                ? `Key "${record.projectLabel}" passed live verification.`
                : record.lastError ?? `Key "${record.projectLabel}" failed test (${record.status}).`,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.delete('/api/v1/vault/keys/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const keyId = Number(req.params.id);
      const deleted = handleDeleteKey(db, keyId);
      res.json({ ok: true, data: { deleted, id: keyId } });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/vault/models', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = resolveActiveProjectId(db, req);
      const discovery = await handleDiscoverModels(db, projectId, effectiveFetch);
      res.json({ ok: true, data: discovery });
    } catch (err) {
      next(err);
    }
  });

  const saveStage0ConfigHandler = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const projectId = requireProjectId(db, req);
      const payload = handleUpdateVaultConfig(db, projectId, req.body ?? {});
      res.json({
        ok: true,
        data: {
          config: payload,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/stage/0/save', saveStage0ConfigHandler);
  app.put('/api/v1/vault/config', saveStage0ConfigHandler);

  // ============================================================================
  // STAGE 0 — MASTER PROMPT OVERRIDE (Part B)
  // ============================================================================
  app.get(
    '/api/v1/stage/0/master-prompt',
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = requireProjectId(db, req);
        const state = getMasterPromptState(db, projectId);
        res.json({ ok: true, data: state });
      } catch (err) {
        next(err);
      }
    }
  );

  app.put(
    '/api/v1/stage/0/master-prompt',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = requireProjectId(db, req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const state = await handleSaveMasterPrompt({
          db,
          projectId,
          text: typeof body.text === 'string' ? body.text : '',
          extractedOverride: body.extractedOverride as
            | Partial<MasterPromptExtraction>
            | undefined,
          gemini,
        });
        res.json({
          ok: true,
          data: {
            ...state,
            ...state.masterPrompt,
            masterPrompt: state.masterPrompt,
            stateVector: getPipelineStateVector(db, projectId),
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ============================================================================
  // STAGE S0B — CHANNEL DNA & STYLE LOCK (Part C)
  // ============================================================================
  app.get('/api/v1/stage/0/dna', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const record = getLockedChannelDna(db, projectId);
      res.json({
        ok: true,
        data: {
          dnaRecord: record,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/v1/stage/0/dna/analyse-channel',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = requireProjectId(db, req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const jobId = createJobRecord(db, projectId, 'S0B', 'FETCHING_CHANNEL', onBroadcast);

        const execTask = async () => {
          updateJobProgress(
            db,
            jobId,
            'S0B',
            40,
            'ANALYSING_VIDEOS',
            'Computing deterministic channel metrics and extracting DNA...',
            onBroadcast
          );
          const result = await handleAnalyseExistingChannelDna({
            db,
            projectId,
            channelInput: String(body.channelInput ?? body.channelUrl ?? ''),
            depth: (body.depth as 'QUICK' | 'STANDARD' | 'DEEP') ?? 'STANDARD',
            manualVideos: Array.isArray(body.manualVideos)
              ? (body.manualVideos as Array<Record<string, unknown>>)
              : undefined,
            uploadedTranscripts:
              body.uploadedTranscripts && typeof body.uploadedTranscripts === 'object'
                ? (body.uploadedTranscripts as Record<string, string>)
                : undefined,
            gemini,
            customFetch: effectiveFetch,
          });
          finishJobRecord(db, jobId, 'S0B', result, onBroadcast);
          return result;
        };

        if (shouldRunDetachedAsync(req)) {
          void execTask().catch((e) => failJobRecord(db, jobId, 'S0B', e, onBroadcast));
          res.status(202).json({
            ok: true,
            jobId,
            data: { jobId, status: 'RUNNING', phase: 'FETCHING_CHANNEL' },
          });
          return;
        }

        try {
          const result = await execTask();
          res.status(202).json({
            ok: true,
            jobId,
            data: {
              jobId,
              ...result,
              stateVector: getPipelineStateVector(db, projectId),
            },
          });
        } catch (innerErr) {
          failJobRecord(db, jobId, 'S0B', innerErr, onBroadcast);
          throw innerErr;
        }
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/stage/0/dna/analyse-niche',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = requireProjectId(db, req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const jobId = createJobRecord(db, projectId, 'S0B', 'GROUNDING_NICHE', onBroadcast);

        const execTask = async () => {
          updateJobProgress(
            db,
            jobId,
            'S0B',
            45,
            'SYNTHESISING_STYLES',
            'Synthesising 3 distinct channel style options...',
            onBroadcast
          );
          const result = await handleAnalyseNicheDna({
            db,
            projectId,
            input: {
              niche: String(body.niche ?? ''),
              subNiche: typeof body.subNiche === 'string' ? body.subNiche : undefined,
              language: typeof body.language === 'string' ? body.language : undefined,
              script: typeof body.script === 'string' ? body.script : undefined,
              formatPreset: body.formatPreset as
                | 'DOCUMENTARY'
                | 'EXPLAINER'
                | 'STORYTIME'
                | 'LISTICLE'
                | undefined,
              tonePreferences:
                typeof body.tonePreferences === 'string'
                  ? body.tonePreferences
                  : typeof body.tone === 'string'
                    ? body.tone
                    : undefined,
              targetAudience:
                typeof body.targetAudience === 'string'
                  ? body.targetAudience
                  : typeof body.audienceLevel === 'string'
                    ? body.audienceLevel
                    : undefined,
              goal: typeof body.goal === 'string' ? body.goal : undefined,
            },
            gemini,
          });
          finishJobRecord(db, jobId, 'S0B', result, onBroadcast);
          return result;
        };

        if (shouldRunDetachedAsync(req)) {
          void execTask().catch((e) => failJobRecord(db, jobId, 'S0B', e, onBroadcast));
          res.status(202).json({
            ok: true,
            jobId,
            data: { jobId, status: 'RUNNING', phase: 'GROUNDING_NICHE' },
          });
          return;
        }

        try {
          const result = await execTask();
          res.status(202).json({
            ok: true,
            jobId,
            data: {
              jobId,
              ...result,
              stateVector: getPipelineStateVector(db, projectId),
            },
          });
        } catch (innerErr) {
          failJobRecord(db, jobId, 'S0B', innerErr, onBroadcast);
          throw innerErr;
        }
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/stage/0/dna/analyse-references',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = requireProjectId(db, req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const jobId = createJobRecord(
          db,
          projectId,
          'S0B',
          'ANALYSING_REFERENCES',
          onBroadcast
        );

        const execTask = async () => {
          const rawChannels = Array.isArray(body.channels) ? body.channels : [];
          const normalizedChannels = rawChannels.map((ch: unknown) => {
            if (typeof ch === 'string') {
              return { channelInput: ch };
            }
            const obj = (ch ?? {}) as Record<string, unknown>;
            return {
              channelInput: String(obj.channelInput ?? obj.url ?? ''),
              manualVideos: Array.isArray(obj.manualVideos)
                ? (obj.manualVideos as Array<Record<string, unknown>>)
                : undefined,
            };
          });
          const result = await handleAnalyseReferenceChannelsDna({
            db,
            projectId,
            channels: normalizedChannels,
            mixConfig: body.mixConfig as
              | {
                  voiceFromIndex?: number;
                  structureFromIndex?: number;
                  visualsFromIndex?: number;
                }
              | undefined,
            gemini,
            customFetch: effectiveFetch,
          });
          finishJobRecord(db, jobId, 'S0B', result, onBroadcast);
          return result;
        };

        if (shouldRunDetachedAsync(req)) {
          void execTask().catch((e) => failJobRecord(db, jobId, 'S0B', e, onBroadcast));
          res.status(202).json({
            ok: true,
            jobId,
            data: { jobId, status: 'RUNNING', phase: 'ANALYSING_REFERENCES' },
          });
          return;
        }

        try {
          const result = await execTask();
          res.status(202).json({
            ok: true,
            jobId,
            data: {
              jobId,
              ...result,
              stateVector: getPipelineStateVector(db, projectId),
            },
          });
        } catch (innerErr) {
          failJobRecord(db, jobId, 'S0B', innerErr, onBroadcast);
          throw innerErr;
        }
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/v1/stage/0/dna/lock', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dnaInput = (body.dna ?? body) as Partial<ChannelDnaRecord>;
      const record = handleLockChannelDna({ db, projectId, dna: dnaInput });
      res.json({
        ok: true,
        data: {
          dnaRecord: record,
          ...record,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/stage/0/dna/unlock', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const unlocked = handleUnlockChannelDna(db, projectId);
      res.json({
        ok: true,
        data: {
          ...unlocked,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/stage/0/quick-style', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const niche = String(body.niche ?? 'General Creator Channel').trim() || 'General Creator Channel';
      const subNiche = String(body.subNiche ?? 'High-Retention Video').trim() || 'High-Retention Video';
      const visualStyle = String(body.visualStyle ?? body.style ?? NEUTRAL_STYLE_PREFIX).trim() || NEUTRAL_STYLE_PREFIX;
      const stylePrefix = String(body.stylePrefix ?? '').trim();
      const brandName = typeof body.brandName === 'string' ? body.brandName.trim() : '';
      const negativePrompts = Array.isArray(body.negativePrompts)
        ? (body.negativePrompts as string[]).map(String)
        : [];
      const formatPreset = String(body.formatPreset ?? 'EXPLAINER').toUpperCase() as ChannelDnaRecord['structure']['formatPreset'];

      // X3: Prefill language/script from detected transcript script if not explicitly supplied
      let detectedPrimary = '';
      let detectedScript = '';
      const transcriptSample =
        typeof body.transcript === 'string' && body.transcript.trim()
          ? body.transcript
          : typeof body.transcriptText === 'string' && body.transcriptText.trim()
            ? body.transcriptText
            : '';
      if (transcriptSample) {
        const det = detectLanguageAndScript(transcriptSample);
        detectedScript = det.script;
        detectedPrimary = det.script === 'Devanagari' ? 'hi' : 'en';
      } else {
        const projMetaRow = db
          .prepare(`SELECT transcript_meta_json FROM projects WHERE id = ?`)
          .get(projectId) as { transcript_meta_json?: string | null } | undefined;
        if (projMetaRow?.transcript_meta_json) {
          try {
            const parsedMeta = JSON.parse(projMetaRow.transcript_meta_json) as {
              detectedLanguage?: { primary?: string; script?: string };
            };
            if (parsedMeta.detectedLanguage?.script) {
              detectedScript = parsedMeta.detectedLanguage.script;
              detectedPrimary =
                parsedMeta.detectedLanguage.script === 'Devanagari'
                  ? 'hi'
                  : parsedMeta.detectedLanguage.primary || 'en';
            }
          } catch {
            // ignore
          }
        }
      }

      const rawScript = String(body.script ?? (detectedScript || 'Latin')).trim();
      const rawLang = String(
        body.language ?? body.primaryLang ?? (detectedPrimary || (rawScript === 'Devanagari' ? 'hi' : 'en'))
      ).trim();

      if (brandName) {
        db.prepare(`UPDATE projects SET brand_name = ?, niche = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
          brandName,
          niche,
          projectId
        );
      } else {
        db.prepare(`UPDATE projects SET niche = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
          niche,
          projectId
        );
      }

      const quickDna = normalizeChannelDnaObject(
        {
          version: 1,
          source: 'EXPRESS',
          identity: {
            niche,
            subNiche,
            pillars: ['Core Topic', 'Key Takeaways', 'Summary'],
            audiencePersona: 'Curious viewers',
            valueProp: 'High-value concise content',
            differentiator: 'Fast direct delivery',
          },
          language: {
            primary: rawLang,
            script: rawScript,
            codeSwitchRatio: 0.1,
            formality: 0.6,
          },
          structure: {
            formatPreset,
            chapters: [],
            hookStyle: 'Direct hook',
            hookSeconds: 15,
            reengageEverySec: [60, 90],
            ctaStyle: 'Clear call to action',
            durationRangeMin: [5, 15],
          },
          visuals: {
            style: stylePrefix || visualStyle,
            palette: [...NEUTRAL_PALETTE],
            lighting: [NEUTRAL_LIGHTING],
            cameraMotion: [NEUTRAL_CAMERA_MOTION],
            negativePrompts,
          },
        },
        { source: 'EXPRESS', niche, script: rawScript, primaryLang: rawLang }
      );

      const record = handleLockChannelDna({ db, projectId, dna: quickDna });
      res.json({
        ok: true,
        data: {
          dnaRecord: record,
          ...record,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // STAGE 1 — TOPICS (OPTION A 10 CARDS + OPTION B CUSTOM ALIGNMENT) & BLACKLIST
  // ============================================================================
  const stage1TopicsHandler = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const mode = String(body.mode ?? (body.topic ? 'custom' : 'ideate'));

      if (mode === 'lock' || body.topicId || body.customTopic) {
        const locked = handleLockTopic(db, projectId, {
          topicId: typeof body.topicId === 'string' ? body.topicId : undefined,
          customTopic: body.customTopic as { title: string } | undefined,
        });
        res.json({
          ok: true,
          data: {
            ...locked,
            stateVector: getPipelineStateVector(db, projectId),
          },
        });
        return;
      }

      const jobId = createJobRecord(db, projectId, 'S1', 'IDEATING_TOPICS', onBroadcast);

      const execTask = async () => {
        const proj = db
          .prepare(`SELECT niche FROM projects WHERE id = ?`)
          .get(projectId) as { niche: string } | undefined;
        const niche = String(body.niche ?? proj?.niche ?? 'Channel Niche').trim();

        if (mode === 'custom') {
          const topic = String(body.topic ?? '').trim();
          updateJobProgress(
            db,
            jobId,
            'S1',
            40,
            'EVALUATING_ALIGNMENT',
            'Scoring custom topic alignment...',
            onBroadcast
          );
          const alignment = await handleEvaluateCustomTopic(db, gemini, projectId, {
            topic,
            niche,
          });
          finishJobRecord(db, jobId, 'S1', alignment, onBroadcast);
          return alignment;
        }

        updateJobProgress(
          db,
          jobId,
          'S1',
          40,
          'GENERATING_CANDIDATES',
          'Generating 10 topic candidates...',
          onBroadcast
        );
        const result = await handleGenerateTopics(db, gemini, projectId, niche);
        finishJobRecord(db, jobId, 'S1', result, onBroadcast);
        return result;
      };

      if (shouldRunDetachedAsync(req)) {
        void execTask().catch((e) => failJobRecord(db, jobId, 'S1', e, onBroadcast));
        res.status(202).json({
          ok: true,
          jobId,
          data: { jobId, status: 'RUNNING', phase: 'IDEATING_TOPICS' },
        });
        return;
      }

      try {
        const result = await execTask();
        res.status(202).json({
          ok: true,
          jobId,
          data: {
            jobId,
            ...result,
            stateVector: getPipelineStateVector(db, projectId),
          },
        });
      } catch (innerErr) {
        failJobRecord(db, jobId, 'S1', innerErr, onBroadcast);
        throw innerErr;
      }
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/stage/1/topics', stage1TopicsHandler);
  app.post('/api/v1/topics/ideate', stage1TopicsHandler);

  app.post('/api/v1/topics/lock', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = handleLockTopic(db, projectId, {
        topicId: typeof body.topicId === 'string' ? body.topicId : undefined,
        customTopic: (body.customTopic ?? body.topic) as { title: string } | undefined,
      });
      res.json({
        ok: true,
        data: {
          ...result,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/blacklist', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = resolveActiveProjectId(db, req) ?? '';
      const items = listBlacklistEntries(db, projectId);
      res.json({ ok: true, data: { items } });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/blacklist', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const entry = addBlacklistEntry(
        db,
        projectId,
        String(body.topicTitle ?? ''),
        String(body.bannedAnchor ?? body.topicTitle ?? '')
      );
      res.status(201).json({ ok: true, data: { entry } });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // STAGE 2 — 2-STEP GROUNDED RESEARCH + MMKG TRIPLES + HUMAN APPROVAL GATE
  // ============================================================================
  const stage2ResearchHandler = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const projectId = requireProjectId(db, req);
      const jobId = createJobRecord(db, projectId, 'S2', 'STEP_2A_GROUNDING', onBroadcast);

      const execTask = async () => {
        updateJobProgress(
          db,
          jobId,
          'S2',
          35,
          'STEP_2A_GROUNDING',
          'Running Google Search grounded research...',
          onBroadcast
        );
        const result = await handleRunResearch(db, gemini, projectId);
        finishJobRecord(db, jobId, 'S2', result, onBroadcast);
        return result;
      };

      if (shouldRunDetachedAsync(req)) {
        void execTask().catch((e) => failJobRecord(db, jobId, 'S2', e, onBroadcast));
        res.status(202).json({
          ok: true,
          jobId,
          data: { jobId, status: 'RUNNING', phase: 'STEP_2A_GROUNDING' },
        });
        return;
      }

      try {
        const result = await execTask();
        res.status(202).json({
          ok: true,
          jobId,
          data: {
            jobId,
            research: result,
            stateVector: getPipelineStateVector(db, projectId),
          },
        });
      } catch (innerErr) {
        failJobRecord(db, jobId, 'S2', innerErr, onBroadcast);
        throw innerErr;
      }
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/stage/2/research', stage2ResearchHandler);
  app.post('/api/v1/studio/research', stage2ResearchHandler);

  app.post('/api/v1/stage/2/approve', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const result = handleApproveResearch(db, projectId);
      res.json({
        ok: true,
        data: {
          research: result,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/v1/stage/2/evidence', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = handleUpdateEvidence(db, projectId, {
        evidenceId: String(body.evidenceId ?? ''),
        action: (body.action as 'toggle' | 'edit' | 'delete') ?? 'toggle',
        claim: typeof body.claim === 'string' ? body.claim : undefined,
        status: body.status as 'VERIFIED' | 'EXCLUDED' | undefined,
      });
      res.json({
        ok: true,
        data: {
          research: result,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // STAGE 2.5 — RUNTIME, WORD BUDGET & HARMON CHAPTERS
  // ============================================================================
  const stage25RuntimeHandler = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (Array.isArray(body.chapters) && !body.regenerate) {
        const updated = handleUpdateRuntimeChapters(db, projectId, {
          targetMinutes: typeof body.targetMinutes === 'number' ? body.targetMinutes : undefined,
          wpm: typeof body.wpm === 'number' ? body.wpm : undefined,
          chapters: body.chapters as Array<{
            phaseIndex: number;
            chapterTitle: string;
            narrativeBeat?: string;
          }>,
        });
        res.json({
          ok: true,
          data: {
            runtime: updated,
            architecture: updated,
            stateVector: getPipelineStateVector(db, projectId),
          },
        });
        return;
      }

      const jobId = createJobRecord(db, projectId, 'S2.5', 'BUILDING_ARCHITECTURE', onBroadcast);

      const execTask = async () => {
        const result = await handleBuildArchitecture(db, gemini, projectId, {
          durationPreset: body.durationPreset as DurationPresetChip | undefined,
          targetMinutes:
            typeof body.targetMinutes === 'number'
              ? body.targetMinutes
              : typeof body.targetDuration === 'number'
                ? body.targetDuration
                : undefined,
          wpm:
            typeof body.wpm === 'number'
              ? body.wpm
              : typeof body.configuredWpm === 'number'
                ? body.configuredWpm
                : undefined,
        });
        finishJobRecord(db, jobId, 'S2.5', result, onBroadcast);
        return result;
      };

      if (shouldRunDetachedAsync(req)) {
        void execTask().catch((e) => failJobRecord(db, jobId, 'S2.5', e, onBroadcast));
        res.status(202).json({
          ok: true,
          jobId,
          data: { jobId, status: 'RUNNING', phase: 'BUILDING_ARCHITECTURE' },
        });
        return;
      }

      try {
        const result = await execTask();
        res.status(202).json({
          ok: true,
          jobId,
          data: {
            jobId,
            runtime: result,
            architecture: result,
            stateVector: getPipelineStateVector(db, projectId),
          },
        });
      } catch (innerErr) {
        failJobRecord(db, jobId, 'S2.5', innerErr, onBroadcast);
        throw innerErr;
      }
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/stage/2_5/runtime', stage25RuntimeHandler);
  app.post('/api/v1/stage/2.5/runtime', stage25RuntimeHandler);
  app.post('/api/v1/studio/architecture', stage25RuntimeHandler);

  app.put('/api/v1/stage/2_5/runtime', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated = handleUpdateRuntimeChapters(db, projectId, {
        targetMinutes: typeof body.targetMinutes === 'number' ? body.targetMinutes : undefined,
        wpm: typeof body.wpm === 'number' ? body.wpm : undefined,
        chapters: body.chapters as
          | Array<{ phaseIndex: number; chapterTitle: string; narrativeBeat?: string }>
          | undefined,
      });
      res.json({
        ok: true,
        data: {
          runtime: updated,
          architecture: updated,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // STAGE 3 — DUAL SCRIPT, 17-POINT AUDIT & TRI-NODE SURGICAL REPAIR
  // ============================================================================
  const stage3ScriptHandler = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const projectId = requireProjectId(db, req);
      const jobId = createJobRecord(db, projectId, 'S3', 'GENERATING_SCRIPT', onBroadcast);

      const execTask = async () => {
        updateJobProgress(
          db,
          jobId,
          'S3',
          40,
          'AUDITING_SCRIPT',
          'Generating dual script and running 17-point audit...',
          onBroadcast
        );
        const result = await handleGenerateAndAuditScript(db, gemini, projectId);
        finishJobRecord(db, jobId, 'S3', result, onBroadcast);
        return result;
      };

      if (shouldRunDetachedAsync(req)) {
        void execTask().catch((e) => failJobRecord(db, jobId, 'S3', e, onBroadcast));
        res.status(202).json({
          ok: true,
          jobId,
          data: { jobId, status: 'RUNNING', phase: 'GENERATING_SCRIPT' },
        });
        return;
      }

      try {
        const result = await execTask();
        res.status(202).json({
          ok: true,
          jobId,
          data: {
            jobId,
            script: result,
            stateVector: getPipelineStateVector(db, projectId),
          },
        });
      } catch (innerErr) {
        failJobRecord(db, jobId, 'S3', innerErr, onBroadcast);
        throw innerErr;
      }
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/stage/3/script', stage3ScriptHandler);
  app.post('/api/v1/script/generate', stage3ScriptHandler);

  const stage3AuditHandler = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const projectId = requireProjectId(db, req);
      const result = await handleAuditExistingScript(db, gemini, projectId);
      res.json({
        ok: true,
        data: {
          script: result,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/stage/3/audit', stage3AuditHandler);
  app.post('/api/v1/script/audit', stage3AuditHandler);

  const stage3RepairHandler = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const jobId = createJobRecord(db, projectId, 'S3', 'SURGICAL_REPAIR', onBroadcast);
      try {
        const result = await handleSurgicalRepairEndpoint(db, gemini, projectId, {
          paragraphIndex:
            typeof body.paragraphIndex === 'number' ? body.paragraphIndex : undefined,
          manualText: typeof body.manualText === 'string' ? body.manualText : undefined,
          manualSpokenText:
            typeof body.manualSpokenText === 'string' ? body.manualSpokenText : undefined,
        });
        finishJobRecord(db, jobId, 'S3', result, onBroadcast);
        res.status(202).json({
          ok: true,
          jobId,
          data: {
            jobId,
            script: result,
            stateVector: getPipelineStateVector(db, projectId),
          },
        });
      } catch (innerErr) {
        failJobRecord(db, jobId, 'S3', innerErr, onBroadcast);
        throw innerErr;
      }
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/stage/3/repair', stage3RepairHandler);
  app.post('/api/v1/script/repair', stage3RepairHandler);

  // ============================================================================
  // STAGE 4 — TRANSCRIPT LOCK & 5% DRIFT ROLLBACK TO S3
  // ============================================================================
  const stage4TranscriptHandler = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawEntryMode = body.entryMode ?? body.mode;
      const entryMode =
        typeof rawEntryMode === 'string' && rawEntryMode.toUpperCase() === 'EXPRESS'
          ? 'EXPRESS'
          : typeof rawEntryMode === 'string' && rawEntryMode.toUpperCase() === 'FULL'
            ? 'FULL'
            : undefined;
      const locked = handleLockTranscript(db, projectId, {
        transcript: (body.transcript ?? body.transcriptContent ?? body.words) as
          | string
          | undefined,
        actualDurationSec:
          typeof body.actualDurationSec === 'number' ? body.actualDurationSec : undefined,
        estimateOnlyPreview: Boolean(body.estimateOnlyPreview),
        entryMode,
        convertFromFull: Boolean(body.convertFromFull),
        confirmEstimated: Boolean(body.confirmEstimated),
        fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
        fileSizeBytes: typeof body.fileSizeBytes === 'number' ? body.fileSizeBytes : undefined,
        scriptText: typeof body.scriptText === 'string' ? body.scriptText : undefined,
        targetDurationSec:
          typeof body.targetDurationSec === 'number'
            ? body.targetDurationSec
            : typeof body.targetMinutes === 'number'
              ? body.targetMinutes * 60
              : undefined,
        unitsOverride: body.unitsOverride as DetectedTimeUnit | undefined,
      });
      res.json({
        ok: true,
        data: {
          transcript: locked,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/stage/4/transcript', stage4TranscriptHandler);
  app.post('/api/v1/script/transcript-lock', stage4TranscriptHandler);

  app.post('/api/v1/stage/4/transcript/preview', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = String(body.transcript ?? body.transcriptContent ?? body.raw ?? '').trim();
      const script = typeof body.scriptText === 'string' ? body.scriptText : undefined;
      const unitsOverride = body.unitsOverride as DetectedTimeUnit | undefined;
      const fileName = typeof body.fileName === 'string' ? body.fileName : undefined;
      const fileSizeBytes = typeof body.fileSizeBytes === 'number' ? body.fileSizeBytes : undefined;

      // X3: Persist detected language metadata even on preview so Quick Style sheet can prefill script/language
      const projectId = resolveActiveProjectId(db, req);
      if (projectId && raw) {
        const det = detectLanguageAndScript(raw);
        db.prepare(
          `UPDATE projects SET transcript_meta_json = COALESCE(transcript_meta_json, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(JSON.stringify({ detectedLanguage: det, fileName }), projectId);
      }

      // X4: Preview and Lock use the exact same validation (allowShort: false)
      const parsed = parseExpressTranscript(raw, script, {
        unitsOverride,
        allowShort: false,
        fileName,
        fileSizeBytes,
      });

      if (projectId) {
        db.prepare(
          `UPDATE projects SET transcript_meta_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(JSON.stringify(parsed.meta), projectId);
      }

      res.json({
        ok: true,
        data: parsed,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/stage/4/transcript', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const s4Row = getStageRow(db, projectId, 'S4');
      if (!s4Row || !s4Row.payload_json) {
        res.json({
          ok: true,
          data: { transcript: null, meta: null },
        });
        return;
      }
      const s4 = JSON.parse(s4Row.payload_json);
      res.json({
        ok: true,
        data: {
          transcript: s4,
          meta: s4.meta ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/v1/stage/4/transcript/tokens', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = String(body.transcript ?? body.transcriptContent ?? '').trim();
      const stripped = stripAndCollectNonSpeechTokens(raw);
      res.json({
        ok: true,
        data: stripped,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/stage/4/rollback', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const rollback = handleRollbackTranscriptDrift(db, projectId);
      res.json({
        ok: true,
        data: {
          ...rollback,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // STAGE 5 — STORYBOARD SLICER (MODEL-LOCKED PACING TABLE)
  // ============================================================================
  app.post('/api/v1/stage/5/storyboard', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;

      const isAsync = shouldRunDetachedAsync(req) || req.query.async === 'true';

      const buildFn = () => {
        const s4Row = getStageRow(db, projectId, 'S4');
        if (!s4Row || s4Row.status !== 'PASSED' || body.transcript || body.actualDurationSec) {
          handleLockTranscript(db, projectId, {
            transcript: body.transcript as string | undefined,
            actualDurationSec:
              typeof body.actualDurationSec === 'number' ? body.actualDurationSec : undefined,
          });
        }

        return handleBuildStoryboard(db, projectId, {
          generationMode: (body.generationMode ?? body.mode) as GenerationMode | undefined,
          videoProvider: (body.videoProvider ?? body.engine ?? body.provider) as
            | VideoProvider
            | undefined,
          defaultClipDuration:
            typeof body.defaultClipDuration === 'number'
              ? body.defaultClipDuration
              : typeof body.durationSec === 'number'
                ? body.durationSec
                : undefined,
        });
      };

      if (isAsync) {
        const jobId = createJobRecord(db, projectId, 'S5', 'BUILDING_STORYBOARD', onBroadcast);
        const execTask = async () => {
          updateJobProgress(db, jobId, 'S5', 50, 'SLICING', 'Slicing storyboard with model-locked pacing...', onBroadcast);
          const storyboard = buildFn();
          finishJobRecord(db, jobId, 'S5', storyboard, onBroadcast);
          return storyboard;
        };

        void execTask().catch((e) => failJobRecord(db, jobId, 'S5', e, onBroadcast));
        res.status(202).json({
          ok: true,
          jobId,
          data: { jobId, status: 'RUNNING', phase: 'BUILDING_STORYBOARD' },
        });
        return;
      }

      const storyboard = buildFn();
      res.json({
        ok: true,
        data: {
          storyboard,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/audio/sync', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const storyboard = handleAudioSyncAndSlice(db, projectId, {
        transcript: body.transcript as string | undefined,
        actualDurationSec:
          typeof body.actualDurationSec === 'number' ? body.actualDurationSec : undefined,
        generationMode: body.generationMode as GenerationMode | undefined,
        videoProvider: body.videoProvider as VideoProvider | undefined,
        defaultClipDuration:
          typeof body.defaultClipDuration === 'number' ? body.defaultClipDuration : undefined,
        allowDriftContinue: Boolean(body.allowDriftContinue),
      });
      res.json({
        ok: true,
        data: {
          storyboard,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // STAGE 6 — VISUAL PROMPTS (30-PROMPT BATCHES & 100-PROMPT PACKS)
  // ============================================================================
  const stage6PromptsHandler = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const projectId = requireProjectId(db, req);
      const jobId = createJobRecord(db, projectId, 'S6', 'TRANSLATING_VISUAL_PROMPTS', onBroadcast);

      const execTask = async () => {
        const prompts = await handleGenerateVisualPrompts(db, gemini, projectId);
        finishJobRecord(db, jobId, 'S6', prompts, onBroadcast);
        return prompts;
      };

      if (shouldRunDetachedAsync(req)) {
        void execTask().catch((e) => failJobRecord(db, jobId, 'S6', e, onBroadcast));
        res.status(202).json({
          ok: true,
          jobId,
          data: { jobId, status: 'RUNNING', phase: 'TRANSLATING_VISUAL_PROMPTS' },
        });
        return;
      }

      try {
        const prompts = await execTask();
        res.status(202).json({
          ok: true,
          jobId,
          data: {
            jobId,
            prompts,
            stateVector: getPipelineStateVector(db, projectId),
          },
        });
      } catch (innerErr) {
        failJobRecord(db, jobId, 'S6', innerErr, onBroadcast);
        throw innerErr;
      }
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/stage/6/prompts', stage6PromptsHandler);
  app.post('/api/v1/export/assemble', stage6PromptsHandler);

  app.post('/api/v1/stage/6/push-pack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const packIndex = Number(body.packIndex ?? 1);
      const s6Row = getStageRow(db, projectId, 'S6');
      if (!s6Row || s6Row.status !== 'PASSED') {
        res.status(409).json({
          ok: false,
          error: {
            code: 'STAGE6_NOT_READY',
            httpStatus: 409,
            message: 'Stage 6 visual prompts have not been generated yet.',
            userMessage: 'Stage 6 visual prompts have not been generated yet.',
            retryable: false,
          },
        });
        return;
      }
      const s6 = JSON.parse(s6Row.payload_json) as Stage6PromptsPayload;
      const targetPack = s6.packs.find((p) => p.packIndex === packIndex) ?? s6.packs[0];
      onBroadcast?.({
        type: 'FLOW_PACK_PUSH',
        payload: {
          projectId,
          pack: targetPack,
        },
      });
      res.json({
        ok: true,
        data: {
          pushed: true,
          pack: targetPack,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // STAGE 7 — PACKAGING (3 PACKS A/B/C, EMRI < 20 GATE) & MASTER ZIP BUNDLE
  // ============================================================================
  app.post(
    '/api/v1/stage/7/packaging',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = requireProjectId(db, req);
        const jobId = createJobRecord(db, projectId, 'S7', 'GENERATING_PACKAGING', onBroadcast);

        const execTask = async () => {
          const packaging = await handleGeneratePackaging(db, gemini, projectId);
          finishJobRecord(db, jobId, 'S7', packaging, onBroadcast);
          return packaging;
        };

        if (shouldRunDetachedAsync(req)) {
          void execTask().catch((e) => failJobRecord(db, jobId, 'S7', e, onBroadcast));
          res.status(202).json({
            ok: true,
            jobId,
            data: { jobId, status: 'RUNNING', phase: 'GENERATING_PACKAGING' },
          });
          return;
        }

        try {
          const packaging = await execTask();
          res.status(202).json({
            ok: true,
            jobId,
            data: {
              jobId,
              packaging,
              stateVector: getPipelineStateVector(db, projectId),
            },
          });
        } catch (innerErr) {
          failJobRecord(db, jobId, 'S7', innerErr, onBroadcast);
          throw innerErr;
        }
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/v1/stage/7/select-pack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const packId = String(body.packId ?? 'PACK_A') as 'PACK_A' | 'PACK_B' | 'PACK_C';
      const packaging = handleSelectPackagingPack(db, projectId, packId);
      res.json({
        ok: true,
        data: {
          packaging,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/export/bundle', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const bundle = await buildMasterExportZip(db, projectId);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${bundle.fileName}"`);
      res.send(bundle.buffer);
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // PIPELINE STATE & INVALIDATION
  // ============================================================================
  app.get('/api/v1/pipeline/state', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projects = db
        .prepare(`SELECT * FROM projects ORDER BY updated_at DESC`)
        .all() as Array<Record<string, unknown>>;

      const activeId = resolveActiveProjectId(db, req);
      const activeProjectRow = activeId
        ? (db.prepare(`SELECT * FROM projects WHERE id = ?`).get(activeId) as
            | Record<string, unknown>
            | undefined)
        : undefined;

      const activeProjectId = activeProjectRow ? String(activeProjectRow.id) : null;
      const stateVector = activeProjectId
        ? getPipelineStateVector(db, activeProjectId)
        : null;
      const channelDna = activeProjectId ? getLockedChannelDna(db, activeProjectId) : null;
      const masterPromptState = activeProjectId
        ? getMasterPromptState(db, activeProjectId)
        : null;
      const llmHealth = handleGetLlmHealth(db);

      res.json({
        ok: true,
        data: {
          mode: runtime.mode,
          showPreviewBanner: runtime.showPreviewBanner,
          projects: projects.map(mapProjectRow),
          activeProject: activeProjectRow ? mapProjectRow(activeProjectRow) : null,
          stateVector,
          channelDna,
          masterPromptState,
          llmHealth,
          keys: handleListKeys(db),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/pipeline/invalidate', (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = requireProjectId(db, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const editedStage = String(body.stageId ?? 'S1') as StageId;
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const invalidated = invalidateDownstreamStages(db, projectId, editedStage, reason);
      res.json({
        ok: true,
        data: {
          editedStage,
          invalidatedStages: invalidated,
          stateVector: getPipelineStateVector(db, projectId),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // DIAGNOSTICS ENDPOINT (P3.6)
  // ============================================================================
  app.get('/api/v1/diagnostics', (req: Request, res: Response, next: NextFunction) => {
    try {
      const dbPath = path.resolve(process.cwd(), 'showrunner.db');
      const walPath = path.resolve(process.cwd(), 'showrunner.db-wal');
      let dbSize = 0;
      let walSize = 0;
      try {
        if (fs.existsSync(dbPath)) dbSize = fs.statSync(dbPath).size;
        if (fs.existsSync(walPath)) walSize = fs.statSync(walPath).size;
      } catch {
        // ignore
      }

      const keys = handleListKeys(db);
      const geminiKeys = keys.filter((k) => k.keyType === 'GEMINI');
      const youtubeKeys = keys.filter((k) => k.keyType === 'YOUTUBE');
      const validGemini = geminiKeys.filter((k) => k.status === 'VALID');
      const validYoutube = youtubeKeys.filter((k) => k.status === 'VALID');

      const logPath = path.resolve(process.cwd(), 'server.log');
      let lastLogs: string[] = [];
      try {
        if (fs.existsSync(logPath)) {
          const content = fs.readFileSync(logPath, 'utf8');
          const lines = content.split('\n').filter((l) => l.trim().length > 0);
          lastLogs = lines.slice(-20);
        }
      } catch {
        // ignore
      }

      const llmHealth = handleGetLlmHealth(db);

      res.json({
        ok: true,
        data: {
          timestamp: new Date().toISOString(),
          runtimeMode: runtime.mode,
          port: runtime.port,
          bindAddress: runtime.host,
          tokenConfigured: Boolean(expectedToken && expectedToken.length > 0),
          clientAuthActive: true,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          uptimeSec: Math.round(process.uptime()),
          memoryUsage: process.memoryUsage(),
          database: {
            dbSize,
            walSize,
            totalSizeBytes: dbSize + walSize,
          },
          geminiKeys: {
            total: geminiKeys.length,
            valid: validGemini.length,
            lastCheckedAt: validGemini[0]?.lastCheckedAt ?? null,
          },
          youtubeKey: {
            configured: youtubeKeys.length > 0,
            valid: validYoutube.length > 0,
            status: youtubeKeys[0]?.status ?? 'NOT_CONFIGURED',
          },
          discoveredModels: llmHealth.models,
          lastLogs,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // STANDARD ERROR ENVELOPE HANDLER (Part A1 mapGeminiError)
  // ============================================================================
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof StageGateError) {
      res.status(err.statusCode).json({
        ok: false,
        error: {
          code: err.code,
          httpStatus: err.statusCode,
          message: err.message,
          userMessage: err.message,
          retryable: false,
        },
      });
      return;
    }

    if (err instanceof VaultDecryptionError) {
      res.status(422).json({
        ok: false,
        error: {
          code: err.code,
          httpStatus: 422,
          message: err.message,
          userMessage: err.message,
          retryable: false,
          details: { keyId: err.keyId },
        },
      });
      return;
    }

    const mapped = mapGeminiError(err);
    const customErr = err as { details?: unknown; offendingIndex?: number };

    res.status(mapped.httpStatus).json({
      ok: false,
      error: {
        code: mapped.code,
        httpStatus: mapped.httpStatus,
        message: mapped.userMessage,
        userMessage: mapped.userMessage,
        retryable: mapped.retryable,
        raw: mapped.raw,
        ...(customErr?.details ? { details: customErr.details } : {}),
        ...(typeof customErr?.offendingIndex === 'number'
          ? { offendingIndex: customErr.offendingIndex }
          : {}),
      },
    });
  });

  return app;
}
