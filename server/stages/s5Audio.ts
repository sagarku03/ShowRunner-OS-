import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_WPM,
  type GenerationMode,
  type VideoProvider,
} from '../../src/config/constants.ts';
import {
  evaluateTranscriptDrift,
  type DriftEvaluation,
} from '../../shared/rules/math.ts';
import {
  parseTranscriptInput,
  sliceTranscriptTimeline,
  type StoryboardSlot,
  type TranscriptWordTimestamp,
} from '../../shared/rules/slicer.ts';
import {
  parseExpressTranscript,
  type ParsedTranscriptMeta,
  type DetectedTimeUnit,
} from '../../shared/rules/transcript.ts';
import { assertStageUnlocked, getStageRow } from '../fsm/gates.ts';
import { invalidateDownstreamStages } from '../fsm/invalidation.ts';
import { commitStageState } from '../fsm/machine.ts';
import { getLockedChannelDna } from './s0bChannelDna.ts';

export interface Stage4TranscriptPayload {
  words: TranscriptWordTimestamp[];
  actualDurationSec: number;
  targetDurationSec: number;
  driftEvaluation: DriftEvaluation;
  drift: boolean;
  driftPct: number;
  suggestedWpm: number;
  rollbackTo: 'S3' | null;
  estimateOnlyPreview?: boolean;
  meta?: ParsedTranscriptMeta;
}

export interface Stage5StoryboardPayload {
  mode: GenerationMode;
  provider: VideoProvider;
  defaultClipDuration: number;
  actualDurationSec: number;
  targetDurationSec: number;
  driftEvaluation: DriftEvaluation;
  slotCount: number;
  slots: StoryboardSlot[];
}

export type Stage5AudioPayload = Stage5StoryboardPayload;

export interface AudioSyncInput {
  transcript?: string | TranscriptWordTimestamp[];
  actualDurationSec?: number;
  generationMode?: GenerationMode;
  videoProvider?: VideoProvider;
  defaultClipDuration?: number;
  allowDriftContinue?: boolean;
  estimateOnlyPreview?: boolean;
  entryMode?: 'FULL' | 'EXPRESS';
  scriptText?: string;
  targetDurationSec?: number;
  unitsOverride?: DetectedTimeUnit;
}

/**
 * Stage 4: Lock Transcript to last word's EndTime and evaluate 5% runtime drift (G11 & Part A4).
 * Zero fabricated timings: missing transcript throws 422 TRANSCRIPT_REQUIRED.
 */
export function handleLockTranscript(
  db: DatabaseSync,
  projectId: string,
  input: AudioSyncInput
): Stage4TranscriptPayload {
  assertStageUnlocked(db, projectId, 'S4');

  const proj = db
    .prepare(
      `SELECT target_duration, configured_wpm, entry_mode
       FROM projects WHERE id = ?`
    )
    .get(projectId) as
    | { target_duration: number; configured_wpm: number; entry_mode?: string }
    | undefined;

  if (!proj) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  const isExpress = input.entryMode === 'EXPRESS' || proj.entry_mode === 'EXPRESS';
  if (input.entryMode === 'EXPRESS' && proj.entry_mode !== 'EXPRESS') {
    db.prepare(`UPDATE projects SET entry_mode = 'EXPRESS', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      projectId
    );
  }

  const s3Row = getStageRow(db, projectId, 'S3');
  if (!isExpress && !s3Row) {
    throw new Error('Stage 3 script payload missing.');
  }

  if (isExpress) {
    for (const stg of ['S1', 'S2', 'S2.5', 'S3'] as const) {
      const cur = getStageRow(db, projectId, stg as any);
      if (!cur) {
        db.prepare(
          `INSERT OR REPLACE INTO project_stages (project_id, stage_id, payload_json, payload_hash, status, is_dirty, updated_at)
           VALUES (?, ?, '{}', 'external', 'EXTERNAL_PROVIDED', 0, CURRENT_TIMESTAMP)`
        ).run(projectId, stg);
      }
    }
  }

  if (
    input.transcript === undefined ||
    input.transcript === null ||
    (typeof input.transcript === 'string' && !input.transcript.trim()) ||
    (Array.isArray(input.transcript) && input.transcript.length === 0)
  ) {
    const err = new Error(
      'TRANSCRIPT_REQUIRED: A real timed transcript (WebVTT, SRT, or JSON word timestamps) is required in Stage 4.'
    ) as Error & { code: string; statusCode: number };
    err.code = 'TRANSCRIPT_REQUIRED';
    err.statusCode = 422;
    throw err;
  }

  let words: TranscriptWordTimestamp[];
  let meta: ParsedTranscriptMeta | undefined;

  if (typeof input.transcript === 'string') {
    const parsed = parseExpressTranscript(input.transcript, input.scriptText, {
      allowShort: false,
      unitsOverride: input.unitsOverride,
    });
    words = parsed.words;
    meta = parsed.meta;
    db.prepare(
      `UPDATE projects SET transcript_meta_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(JSON.stringify(meta), projectId);
  } else {
    words = parseTranscriptInput(input.transcript);
  }

  if (words.length === 0) {
    const err = new Error('TRANSCRIPT_REQUIRED: Parsed transcript contained zero timed words.') as Error & {
      code: string;
      statusCode: number;
    };
    err.code = 'TRANSCRIPT_REQUIRED';
    err.statusCode = 422;
    throw err;
  }

  const lastWord = words[words.length - 1];
  const lastWordEnd =
    typeof lastWord.endMs === 'number'
      ? Number((lastWord.endMs / 1000).toFixed(3))
      : lastWord.endSec;
  const actualDurationSec =
    typeof input.actualDurationSec === 'number' && input.actualDurationSec > 0
      ? input.actualDurationSec
      : lastWordEnd;

  const hasExplicitTarget =
    typeof input.targetDurationSec === 'number' && input.targetDurationSec > 0;
  const targetDurationSec = hasExplicitTarget
    ? input.targetDurationSec!
    : isExpress
      ? 0
      : (proj.target_duration || 11) * 60;

  let driftEvaluation: DriftEvaluation;
  if (targetDurationSec > 0) {
    driftEvaluation = evaluateTranscriptDrift({
      targetDurationSec,
      actualDurationSec,
      wordCount: words.length,
    });
  } else {
    const actualWpm =
      actualDurationSec > 0
        ? Number(((words.length / (actualDurationSec / 60))).toFixed(2))
        : DEFAULT_WPM;
    driftEvaluation = {
      targetDurationSec: Number(actualDurationSec.toFixed(3)),
      actualDurationSec: Number(actualDurationSec.toFixed(3)),
      driftRatio: 0,
      driftPercent: 0,
      driftPct: 0,
      exceedsThreshold: false,
      drift: false,
      actualWpm,
      suggestedWpm: actualWpm,
      rollbackTo: null,
    };
  }

  db.prepare(
    `UPDATE projects
     SET actual_wpm = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(driftEvaluation.actualWpm, projectId);

  invalidateDownstreamStages(db, projectId, 'S4', 'Transcript replaced');

  const payload: Stage4TranscriptPayload = {
    words,
    actualDurationSec: Number(actualDurationSec.toFixed(3)),
    targetDurationSec,
    driftEvaluation,
    drift: driftEvaluation.exceedsThreshold,
    driftPct: driftEvaluation.driftPercent,
    suggestedWpm: driftEvaluation.actualWpm,
    rollbackTo: targetDurationSec > 0 && driftEvaluation.exceedsThreshold ? 'S3' : null,
    meta,
  };

  commitStageState(db, {
    projectId,
    stageId: 'S4',
    payload,
    status: 'PASSED',
  });

  return payload;
}

/**
 * Stage 4 One-Click Rollback to Stage 3 (G11):
 * Updates configured_wpm = actual_wpm, marks S3..S7 DIRTY, and sets active_state = 'S3'.
 */
export function handleRollbackTranscriptDrift(
  db: DatabaseSync,
  projectId: string
): {
  rolledBackTo: 'S3';
  configuredWpm: number;
  targetWords: number;
} {
  const proj = db
    .prepare(`SELECT target_duration, configured_wpm, actual_wpm FROM projects WHERE id = ?`)
    .get(projectId) as
    | { target_duration: number; configured_wpm: number; actual_wpm: number | null }
    | undefined;

  if (!proj) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  let nextWpm = proj.actual_wpm ?? proj.configured_wpm ?? DEFAULT_WPM;
  const s4Row = getStageRow(db, projectId, 'S4');
  if (s4Row) {
    try {
      const s4 = JSON.parse(s4Row.payload_json) as Stage4TranscriptPayload;
      if (s4.suggestedWpm > 0) {
        nextWpm = s4.suggestedWpm;
      }
    } catch {
      // ignore
    }
  }

  const targetWords = Math.round((proj.target_duration || 11) * nextWpm);

  db.prepare(
    `UPDATE projects
     SET configured_wpm = ?, target_words = ?, active_state = 'S3', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(nextWpm, targetWords, projectId);

  // Mark S3 and all downstream stages S4..S7 as DIRTY
  db.prepare(
    `UPDATE project_stages
     SET is_dirty = 1, updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ? AND stage_id IN ('S3', 'S4', 'S5', 'S6', 'S7')`
  ).run(projectId);
  invalidateDownstreamStages(db, projectId, 'S3');

  return {
    rolledBackTo: 'S3',
    configuredWpm: nextWpm,
    targetWords,
  };
}

/**
 * Stage 5: Deterministic Storyboard Slicer with Model-Locked Pacing Table (G4 & Part C8).
 * Clamps DNA cut-length preference inside the model-locked pacing bounds (never outside).
 */
export function handleBuildStoryboard(
  db: DatabaseSync,
  projectId: string,
  input?: {
    generationMode?: GenerationMode;
    videoProvider?: VideoProvider;
    defaultClipDuration?: number;
  }
): Stage5StoryboardPayload {
  assertStageUnlocked(db, projectId, 'S5');

  const proj = db
    .prepare(
      `SELECT generation_mode, video_provider, default_clip_duration
       FROM projects WHERE id = ?`
    )
    .get(projectId) as
    | {
        generation_mode: GenerationMode;
        video_provider: VideoProvider;
        default_clip_duration: number;
      }
    | undefined;

  if (!proj) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  const s4Row = getStageRow(db, projectId, 'S4');
  if (!s4Row) {
    throw new Error('Stage 4 locked transcript missing.');
  }
  const s4 = JSON.parse(s4Row.payload_json) as Stage4TranscriptPayload;

  const lockedDna = getLockedChannelDna(db, projectId)?.dna;
  const mode = input?.generationMode ?? proj.generation_mode ?? 'MODE_2_VIDEO';
  const provider = input?.videoProvider ?? proj.video_provider ?? 'VEO_3_1';
  const defaultClipDuration =
    typeof input?.defaultClipDuration === 'number'
      ? input.defaultClipDuration
      : proj.default_clip_duration || 8;

  const slots = sliceTranscriptTimeline({
    words: s4.words,
    mode,
    provider,
    defaultClipDuration,
    preferredCutRangeSec: lockedDna?.pacing.cutDurationSec ?? null,
  });

  db.prepare(
    `UPDATE projects
     SET generation_mode = ?, video_provider = ?, default_clip_duration = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(mode, provider, defaultClipDuration, projectId);

  const payload: Stage5StoryboardPayload = {
    mode,
    provider,
    defaultClipDuration,
    actualDurationSec: s4.actualDurationSec,
    targetDurationSec: s4.targetDurationSec,
    driftEvaluation: s4.driftEvaluation,
    slotCount: slots.length,
    slots,
  };

  commitStageState(db, {
    projectId,
    stageId: 'S5',
    payload,
    status: 'PASSED',
  });

  return payload;
}

/**
 * Combined Stage 4 + Stage 5 helper for callers that sync transcript and slice storyboard in one step.
 */
export function handleAudioSyncAndSlice(
  db: DatabaseSync,
  projectId: string,
  input: AudioSyncInput
): Stage5StoryboardPayload {
  const s4 = handleLockTranscript(db, projectId, input);

  if (s4.drift && !input.allowDriftContinue) {
    db.prepare(
      `UPDATE projects
       SET configured_wpm = ?, target_words = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      s4.suggestedWpm,
      Math.round((s4.targetDurationSec / 60) * s4.suggestedWpm),
      projectId
    );
  }

  return handleBuildStoryboard(db, projectId, {
    generationMode: input.generationMode,
    videoProvider: input.videoProvider,
    defaultClipDuration: input.defaultClipDuration,
  });
}
