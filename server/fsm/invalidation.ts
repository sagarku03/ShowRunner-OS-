import type { DatabaseSync } from 'node:sqlite';
import { LINEAR_PIPELINE_STAGES, type StageId } from '../../src/config/constants.ts';

export function getDownstreamStages(editedStage: StageId): StageId[] {
  const idx = LINEAR_PIPELINE_STAGES.indexOf(editedStage);
  if (idx === -1 || idx >= LINEAR_PIPELINE_STAGES.length - 1) {
    return [];
  }
  return LINEAR_PIPELINE_STAGES.slice(idx + 1);
}

export function invalidateDownstreamStages(
  db: DatabaseSync,
  projectId: string,
  editedStage: StageId,
  reason?: string
): StageId[] {
  const downstream = getDownstreamStages(editedStage);
  if (downstream.length === 0) {
    return [];
  }

  const placeholders = downstream.map(() => '?').join(', ');
  if (reason) {
    db.prepare(
      `UPDATE project_stages
       SET is_dirty = 1,
           status = CASE WHEN status = 'PASSED' THEN 'DIRTY' ELSE status END,
           error_message = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?
         AND stage_id IN (${placeholders})`
    ).run(reason, projectId, ...downstream);
  } else {
    db.prepare(
      `UPDATE project_stages
       SET is_dirty = 1,
           status = CASE WHEN status = 'PASSED' THEN 'DIRTY' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?
         AND stage_id IN (${placeholders})`
    ).run(projectId, ...downstream);
  }

  db.prepare(
    `INSERT INTO audit_log (project_id, stage_id, event_type, details_json)
     VALUES (?, ?, 'CASCADE_INVALIDATE', ?)`
  ).run(
    projectId,
    editedStage,
    JSON.stringify({ editedStage, invalidatedStages: downstream, reason: reason ?? null })
  );

  return downstream;
}

export const cascadeInvalidateDownstream = invalidateDownstreamStages;
export const markDownstreamStagesDirty = invalidateDownstreamStages;
