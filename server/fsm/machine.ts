import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  LINEAR_PIPELINE_STAGES,
  type StageId,
  type StageStatus,
} from '../../src/config/constants.ts';
import { computePayloadHash, withTransaction } from '../db/db.ts';
import { invalidateDownstreamStages } from './invalidation.ts';

export interface StageContextEntry {
  stageId: StageId;
  status: StageStatus;
  isDirty: boolean;
  payloadHash: string;
  updatedAt: string;
  payload: unknown;
}

export interface PipelineStateVector {
  projectId: string;
  current: StageId;
  history: StageId[];
  context: Record<string, StageContextEntry>;
  integrityHash: string;
  epoch: number;
}

export function commitStageState(
  db: DatabaseSync,
  params: {
    projectId: string;
    stageId: StageId;
    payload: unknown;
    status: StageStatus;
    invalidateDownstream?: boolean;
  }
): PipelineStateVector {
  const {
    projectId,
    stageId,
    payload,
    status,
    invalidateDownstream = true,
  } = params;

  const payloadJson = JSON.stringify(payload);
  const payloadHash = computePayloadHash(payloadJson);

  return withTransaction(db, () => {
    db.prepare(
      `INSERT INTO project_stages (project_id, stage_id, payload_json, payload_hash, status, is_dirty, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
       ON CONFLICT(project_id, stage_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         payload_hash = excluded.payload_hash,
         status = excluded.status,
         is_dirty = 0,
         updated_at = CURRENT_TIMESTAMP`
    ).run(projectId, stageId, payloadJson, payloadHash, status);

    if (invalidateDownstream) {
      invalidateDownstreamStages(db, projectId, stageId);
    }

    const nextActiveState: StageId = status === 'FAILED' ? 'S_error' : stageId;

    db.prepare(
      `UPDATE projects
       SET active_state = ?,
           epoch = epoch + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(nextActiveState, projectId);

    db.prepare(
      `INSERT INTO audit_log (project_id, stage_id, event_type, details_json)
       VALUES (?, ?, 'STAGE_COMMIT', ?)`
    ).run(
      projectId,
      stageId,
      JSON.stringify({ status, payloadHash })
    );

    return getPipelineStateVector(db, projectId);
  });
}

export function getPipelineStateVector(
  db: DatabaseSync,
  projectId: string
): PipelineStateVector {
  const projectRow = db
    .prepare(`SELECT id, active_state, epoch FROM projects WHERE id = ?`)
    .get(projectId) as { id: string; active_state: StageId; epoch: number } | undefined;

  if (!projectRow) {
    throw new Error(`Project "${projectId}" not found`);
  }

  const stageRows = db
    .prepare(
      `SELECT stage_id, payload_json, payload_hash, status, is_dirty, updated_at
       FROM project_stages
       WHERE project_id = ?`
    )
    .all(projectId) as Array<{
    stage_id: StageId;
    payload_json: string;
    payload_hash: string;
    status: StageStatus;
    is_dirty: number;
    updated_at: string;
  }>;

  const rowMap = new Map<StageId, (typeof stageRows)[number]>();
  for (const r of stageRows) {
    rowMap.set(r.stage_id, r);
  }

  const context: Record<string, StageContextEntry> = {};
  const history: StageId[] = [];

  for (const st of LINEAR_PIPELINE_STAGES) {
    const r = rowMap.get(st);
    if (r) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(r.payload_json);
      } catch {
        parsed = null;
      }
      context[st] = {
        stageId: st,
        status: r.status,
        isDirty: r.is_dirty === 1,
        payloadHash: r.payload_hash,
        updatedAt: r.updated_at,
        payload: parsed,
      };
      if (r.status === 'PASSED') {
        history.push(st);
      }
    } else {
      context[st] = {
        stageId: st,
        status: 'PENDING',
        isDirty: false,
        payloadHash: '',
        updatedAt: '',
        payload: null,
      };
    }
  }

  const integrityHash = crypto
    .createHash('sha256')
    .update(
      LINEAR_PIPELINE_STAGES.map(
        (s) => `${s}:${context[s].status}:${context[s].isDirty ? 1 : 0}:${context[s].payloadHash}`
      ).join('|')
    )
    .digest('hex');

  return {
    projectId,
    current: projectRow.active_state,
    history,
    context,
    integrityHash,
    epoch: projectRow.epoch,
  };
}
