import type { DatabaseSync } from 'node:sqlite';
import {
  LINEAR_PIPELINE_STAGES,
  type StageId,
  type StageStatus,
} from '../../src/config/constants.ts';

export class StageGateError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, code: string = 'STAGE_GATE_BLOCKED', statusCode: number = 409) {
    super(message);
    this.name = 'StageGateError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const GateBlockedError = StageGateError;

export interface StageRow {
  project_id: string;
  stage_id: StageId;
  payload_json: string;
  payload_hash: string;
  status: StageStatus;
  is_dirty: number;
  error_message?: string | null;
  updated_at: string;
}

export function getStageRow(
  db: DatabaseSync,
  projectId: string,
  stageId: StageId
): StageRow | undefined {
  return db
    .prepare(
      `SELECT project_id, stage_id, payload_json, payload_hash, status, is_dirty, error_message, updated_at
       FROM project_stages
       WHERE project_id = ? AND stage_id = ?`
    )
    .get(projectId, stageId) as StageRow | undefined;
}

export function assertStageUnlocked(
  db: DatabaseSync,
  projectId: string,
  targetStage: StageId
): void {
  if (targetStage === 'S0' || targetStage === 'S0B' || targetStage === 'S_error') {
    return;
  }

  const activeKeyCount = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM api_keys
       WHERE COALESCE(key_type, 'GEMINI') = 'GEMINI'
         AND (
           status IN ('VALID', 'ACTIVE')
           OR (status IN ('COOLDOWN_429', 'COOLING_DOWN') AND cooldown_until IS NOT NULL AND cooldown_until <= datetime('now'))
         )`
    )
    .get() as { cnt: number } | undefined;

  if (!activeKeyCount || activeKeyCount.cnt === 0) {
    throw new StageGateError(
      'Stage 0 Gate Blocked: At least one VALID Gemini API key must be stored in the Vault before executing downstream stages.',
      'NO_ACTIVE_API_KEY',
      409
    );
  }

  // C7: Running S1+ without a locked DNA returns 409 GATE_DNA_NOT_LOCKED
  const projRow = db
    .prepare(`SELECT dna_version FROM projects WHERE id = ?`)
    .get(projectId) as { dna_version: number | null } | undefined;

  const s0bRow = getStageRow(db, projectId, 'S0B');
  if (
    !projRow ||
    !projRow.dna_version ||
    projRow.dna_version <= 0 ||
    (s0bRow && (s0bRow.is_dirty === 1 || s0bRow.status === 'DIRTY'))
  ) {
    throw new StageGateError(
      'Stage S0B Gate Blocked: Channel DNA & Style Lock must be locked before running Stage 1 or downstream stages.',
      'GATE_DNA_NOT_LOCKED',
      409
    );
  }

  if (targetStage === 'S1') {
    return;
  }

  const targetIdx = LINEAR_PIPELINE_STAGES.indexOf(targetStage);
  if (targetIdx <= 1) {
    return;
  }

  const projMeta = db
    .prepare(`SELECT entry_mode FROM projects WHERE id = ?`)
    .get(projectId) as { entry_mode?: string } | undefined;
  const isExpress = projMeta?.entry_mode === 'EXPRESS';

  for (let i = 1; i < targetIdx; i++) {
    const reqStage = LINEAR_PIPELINE_STAGES[i];
    if (
      isExpress &&
      (reqStage === 'S1' || reqStage === 'S2' || reqStage === 'S2.5' || reqStage === 'S3')
    ) {
      continue;
    }
    const row = getStageRow(db, projectId, reqStage);

    if (!row) {
      throw new StageGateError(
        `Prerequisite Stage ${reqStage} has not been completed yet. Complete ${reqStage} before running ${targetStage}.`,
        'PREREQUISITE_STAGE_MISSING',
        409
      );
    }

    if (row.is_dirty === 1 || row.status === 'DIRTY' || row.status === 'INVALIDATED') {
      throw new StageGateError(
        `Upstream Stage ${reqStage} is marked DIRTY/INVALIDATED after an edit. Re-run ${reqStage} before proceeding to ${targetStage}.`,
        'UPSTREAM_STAGE_DIRTY',
        409
      );
    }

    if (reqStage === 'S2') {
      try {
        const s2Parsed = JSON.parse(row.payload_json) as { approved?: boolean };
        if (!s2Parsed.approved) {
          throw new StageGateError(
            `Stage 2 Research Dossier has not been human-approved yet. Call POST /api/v1/stage/2/approve before running ${targetStage}.`,
            'GATE_RESEARCH_NOT_APPROVED',
            409
          );
        }
      } catch (err) {
        if (err instanceof StageGateError) throw err;
      }
    }

    if (reqStage === 'S4') {
      try {
        const s4Parsed = JSON.parse(row.payload_json) as { estimateOnlyPreview?: boolean };
        if (s4Parsed.estimateOnlyPreview) {
          throw new StageGateError(
            'Stage 4 is in Estimate-Only Preview mode. Upload a real timed transcript before running Stage 5–7.',
            'TRANSCRIPT_REQUIRED',
            422
          );
        }
      } catch (err) {
        if (err instanceof StageGateError) throw err;
      }
    }

    if (row.status !== 'PASSED') {
      throw new StageGateError(
        `Prerequisite Stage ${reqStage} is in status "${row.status}" (requires PASSED) before running ${targetStage}.`,
        'PREREQUISITE_STAGE_NOT_PASSED',
        409
      );
    }
  }
}
