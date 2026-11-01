import type { DatabaseSync } from 'node:sqlite';
import { Type, type Schema } from '@google/genai';
import {
  DEFAULT_WPM,
  DURATION_PRESET_MIDPOINTS,
  HARMON_PHASES,
  METAPHOR_PASS_SCORE,
  WPM_MAX,
  WPM_MIN,
  type DurationPresetChip,
} from '../../src/config/constants.ts';
import {
  calculateWordBudget,
  type HarmonPhaseBudget,
  type WordBudgetResult,
} from '../../shared/rules/math.ts';
import { assertStageUnlocked, getStageRow } from '../fsm/gates.ts';
import { invalidateDownstreamStages } from '../fsm/invalidation.ts';
import { commitStageState } from '../fsm/machine.ts';
import type { GeminiGateway } from '../llm/gemini.ts';
import {
  buildMasterPromptInjectionBlock,
  getMasterPromptState,
} from './s0MasterPrompt.ts';
import { buildChannelDnaPromptBlock, getLockedChannelDna } from './s0bChannelDna.ts';
import type { Stage2ResearchPayload } from './s2Research.ts';

export interface MetaphorCandidate {
  id: string;
  metaphor: string;
  visceralScore: number;
  clarityScore: number;
  noveltyScore: number;
  retentionScore: number;
  compositeScore: number;
  rationale: string;
}

export interface HarmonChapterPlan extends HarmonPhaseBudget {
  chapterTitle: string;
  narrativeBeat: string;
  anchorIds: string[];
}

export interface Stage25RuntimePayload {
  durationPreset?: DurationPresetChip;
  targetMinutes: number;
  wpm: number;
  wordBudget: WordBudgetResult;
  chapters: HarmonChapterPlan[];
  metaphorCandidates: MetaphorCandidate[];
  selectedMetaphor: MetaphorCandidate;
  cognitiveAnchors: Array<{
    phaseName: string;
    primaryClaimId: string;
    counterpointClaimId: string;
    emotionalFrictionCue: string;
  }>;
}

export type Stage3ArchPayload = Stage25RuntimePayload;

const ARCH_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    chapters: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          phaseIndex: { type: Type.NUMBER },
          chapterTitle: { type: Type.STRING },
          narrativeBeat: { type: Type.STRING },
          anchorIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['phaseIndex', 'chapterTitle', 'narrativeBeat', 'anchorIds'],
      },
    },
    metaphorCandidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          metaphor: { type: Type.STRING },
          visceralScore: { type: Type.NUMBER },
          clarityScore: { type: Type.NUMBER },
          noveltyScore: { type: Type.NUMBER },
          retentionScore: { type: Type.NUMBER },
          rationale: { type: Type.STRING },
        },
        required: [
          'id',
          'metaphor',
          'visceralScore',
          'clarityScore',
          'noveltyScore',
          'retentionScore',
          'rationale',
        ],
      },
    },
    cognitiveAnchors: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          phaseName: { type: Type.STRING },
          primaryClaimId: { type: Type.STRING },
          counterpointClaimId: { type: Type.STRING },
          emotionalFrictionCue: { type: Type.STRING },
        },
        required: ['phaseName', 'primaryClaimId', 'counterpointClaimId', 'emotionalFrictionCue'],
      },
    },
  },
  required: ['chapters', 'metaphorCandidates', 'cognitiveAnchors'],
};

export async function handleBuildArchitecture(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string,
  options?: {
    durationPreset?: DurationPresetChip;
    targetMinutes?: number;
    wpm?: number;
  }
): Promise<Stage25RuntimePayload> {
  assertStageUnlocked(db, projectId, 'S2.5');

  const proj = db
    .prepare(`SELECT target_duration, configured_wpm FROM projects WHERE id = ?`)
    .get(projectId) as { target_duration: number; configured_wpm: number } | undefined;

  const lockedDna = getLockedChannelDna(db, projectId)?.dna;
  const masterState = getMasterPromptState(db, projectId);

  let resolvedMinutes = Number(options?.targetMinutes ?? proj?.target_duration ?? 11);
  if (options?.durationPreset && DURATION_PRESET_MIDPOINTS[options.durationPreset]) {
    resolvedMinutes = DURATION_PRESET_MIDPOINTS[options.durationPreset];
  }
  if (!Number.isFinite(resolvedMinutes) || resolvedMinutes <= 0) {
    resolvedMinutes = 11;
  }

  const rawWpm = Number(
    options?.wpm ?? lockedDna?.voice.wpm ?? proj?.configured_wpm ?? DEFAULT_WPM
  );
  const wpm = Math.min(WPM_MAX, Math.max(WPM_MIN, Number.isFinite(rawWpm) ? rawWpm : DEFAULT_WPM));

  // Part B & C8: MASTER_PROMPT chapters override when locked with >= 2 chapters;
  // otherwise Master Prompt customChapters override Harmon template when provided;
  // otherwise non-DOCUMENTARY DNA formatPreset chapters override when provided.
  const wordBudget =
    lockedDna?.source === 'MASTER_PROMPT' && lockedDna.structure.chapters.length >= 2
      ? calculateWordBudget(resolvedMinutes, wpm, {
          customPhases: lockedDna.structure.chapters,
        })
      : masterState.extracted.customChapters.length > 0
        ? calculateWordBudget(resolvedMinutes, wpm, {
            customChapterTitles: masterState.extracted.customChapters,
          })
        : lockedDna &&
            lockedDna.structure.formatPreset !== 'DOCUMENTARY' &&
            lockedDna.structure.chapters.length > 0
          ? calculateWordBudget(resolvedMinutes, wpm, {
              customPhases: lockedDna.structure.chapters,
            })
          : calculateWordBudget(resolvedMinutes, wpm);

  const s2Row = getStageRow(db, projectId, 'S2');
  if (!s2Row) {
    throw new Error('Stage 2 research payload missing.');
  }
  const s2 = JSON.parse(s2Row.payload_json) as Stage2ResearchPayload;
  if (!s2.approved) {
    const err = new Error(
      'Stage 2 Research Dossier must be human-approved before Stage 2.5 Runtime & Architecture.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 409;
    err.code = 'GATE_RESEARCH_NOT_APPROVED';
    throw err;
  }

  const masterBlock = buildMasterPromptInjectionBlock(db, projectId);
  const dnaBlock = buildChannelDnaPromptBlock(lockedDna, 'S2.5');

  const systemInstruction = [
    'You are the Stage 2.5 Runtime, Word Budget & Narrative Chapter Engine for ShowRunner OS v1.3.0.',
    'Map the verified research claims into the narrative chapter phases with compelling, niche-specific chapter titles.',
    'Generate 5 distinct visual/cognitive metaphor candidates scored on 4 dimensions (0-10 each, total /40; at least one >= 36).',
    'Pair primary and counterpoint claims into cognitive anchors across the phases.',
    dnaBlock,
    masterBlock,
  ].join('\n');

  const verifiedList = (s2.verifiedClaims || [])
    .map((c) => `${c.id}: ${c.claim} (${c.institution}, ${c.year})`)
    .join('\n');

  const userPrompt = [
    `Topic: ${s2.topicTitle}`,
    `Primary Anchor: ${s2.primaryAnchor}`,
    `Counter Anchor: ${s2.counterAnchor}`,
    `Target Runtime: ${resolvedMinutes} minutes @ ${wpm} WPM (${wordBudget.totalWords} words, ${wordBudget.paragraphCount} paragraphs)`,
    `Verified Claims:\n${verifiedList}`,
    `Target Phases: ${wordBudget.phases.map((p) => `${p.phaseIndex}. ${p.phaseName}`).join(', ')}`,
    `Harmon Reference Phases: ${HARMON_PHASES.map((p, i) => `${i + 1}. ${p.name}`).join(', ')}`,
  ].join('\n\n');

  const response = await gemini.generateStructured<{
    chapters: Array<{
      phaseIndex: number;
      chapterTitle: string;
      narrativeBeat: string;
      anchorIds: string[];
    }>;
    metaphorCandidates: Array<Omit<MetaphorCandidate, 'compositeScore'>>;
    cognitiveAnchors: Stage25RuntimePayload['cognitiveAnchors'];
  }>({
    db,
    projectId,
    stage: 'S2.5',
    tier: 'TIER_REASONING',
    systemInstruction,
    userPrompt,
    responseSchema: ARCH_RESPONSE_SCHEMA,
    temperature: 0.4,
  });

  const chapters: HarmonChapterPlan[] = wordBudget.phases.map((phaseBudget, idx) => {
    const matched = (response.data.chapters || []).find(
      (c) => Number(c.phaseIndex) === phaseBudget.phaseIndex
    );
    const customOverrideTitle = masterState.extracted.customChapters[idx];
    return {
      ...phaseBudget,
      chapterTitle:
        customOverrideTitle ||
        matched?.chapterTitle ||
        `${phaseBudget.phaseName}: ${s2.topicTitle}`,
      narrativeBeat:
        matched?.narrativeBeat ||
        `Advance ${phaseBudget.phaseName} within ${phaseBudget.targetWords} words (${phaseBudget.paragraphCount} paragraphs).`,
      anchorIds:
        matched?.anchorIds && matched.anchorIds.length > 0
          ? matched.anchorIds
          : s2.verifiedClaims.slice(0, 2).map((c) => c.id),
    };
  });

  const candidates: MetaphorCandidate[] = (response.data.metaphorCandidates || []).map(
    (m, idx) => {
      const visceral = Math.min(10, Math.max(0, Number(m.visceralScore) || 9));
      const clarity = Math.min(10, Math.max(0, Number(m.clarityScore) || 9));
      const novelty = Math.min(10, Math.max(0, Number(m.noveltyScore) || 9));
      const retention = Math.min(10, Math.max(0, Number(m.retentionScore) || 9));
      const compositeScore = visceral + clarity + novelty + retention;
      return {
        id: m.id || `meta-${idx + 1}`,
        metaphor: m.metaphor,
        visceralScore: visceral,
        clarityScore: clarity,
        noveltyScore: novelty,
        retentionScore: retention,
        compositeScore,
        rationale: m.rationale,
      };
    }
  );

  const sortedMetaphors = [...candidates].sort((a, b) => b.compositeScore - a.compositeScore);
  const bestMetaphor = sortedMetaphors[0];

  if (!bestMetaphor || bestMetaphor.compositeScore < METAPHOR_PASS_SCORE) {
    const err = new Error(
      `Metaphor Gate Failed: top metaphor scored ${bestMetaphor?.compositeScore ?? 0}/40 (< ${METAPHOR_PASS_SCORE}/40 required).`
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 422;
    err.code = 'METAPHOR_SCORE_LOW';
    throw err;
  }

  db.prepare(
    `UPDATE projects
     SET target_duration = ?, configured_wpm = ?, target_words = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(resolvedMinutes, wpm, wordBudget.totalWords, projectId);

  const payload: Stage25RuntimePayload = {
    durationPreset: options?.durationPreset,
    targetMinutes: resolvedMinutes,
    wpm,
    wordBudget,
    chapters,
    metaphorCandidates: sortedMetaphors,
    selectedMetaphor: bestMetaphor,
    cognitiveAnchors: response.data.cognitiveAnchors || [],
  };

  commitStageState(db, {
    projectId,
    stageId: 'S2.5',
    payload,
    status: 'PASSED',
  });

  return payload;
}

export function handleUpdateRuntimeChapters(
  db: DatabaseSync,
  projectId: string,
  updates: {
    targetMinutes?: number;
    wpm?: number;
    chapters?: Array<{ phaseIndex: number; chapterTitle: string; narrativeBeat?: string }>;
  }
): Stage25RuntimePayload {
  const s25Row = getStageRow(db, projectId, 'S2.5');
  if (!s25Row) {
    throw new Error('Stage 2.5 runtime payload not found. Generate runtime architecture first.');
  }

  const payload = JSON.parse(s25Row.payload_json) as Stage25RuntimePayload;

  const nextMinutes =
    typeof updates.targetMinutes === 'number' && updates.targetMinutes > 0
      ? updates.targetMinutes
      : payload.targetMinutes;
  const nextWpm =
    typeof updates.wpm === 'number' && updates.wpm >= WPM_MIN && updates.wpm <= WPM_MAX
      ? updates.wpm
      : payload.wpm;

  const nextBudget = calculateWordBudget(nextMinutes, nextWpm);
  payload.targetMinutes = nextMinutes;
  payload.wpm = nextWpm;
  payload.wordBudget = nextBudget;

  payload.chapters = nextBudget.phases.map((phaseBudget) => {
    const existing = payload.chapters.find((c) => c.phaseIndex === phaseBudget.phaseIndex);
    const edit = updates.chapters?.find((u) => Number(u.phaseIndex) === phaseIndexNumber(phaseBudget));
    return {
      ...phaseBudget,
      chapterTitle:
        edit?.chapterTitle && edit.chapterTitle.trim()
          ? edit.chapterTitle.trim()
          : existing?.chapterTitle || phaseBudget.phaseName,
      narrativeBeat:
        edit?.narrativeBeat && edit.narrativeBeat.trim()
          ? edit.narrativeBeat.trim()
          : existing?.narrativeBeat || '',
      anchorIds: existing?.anchorIds || [],
    };
  });

  db.prepare(
    `UPDATE projects
     SET target_duration = ?, configured_wpm = ?, target_words = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(nextMinutes, nextWpm, nextBudget.totalWords, projectId);

  commitStageState(db, {
    projectId,
    stageId: 'S2.5',
    payload,
    status: 'PASSED',
  });
  invalidateDownstreamStages(db, projectId, 'S2.5');

  return payload;
}

function phaseIndexNumber(p: HarmonPhaseBudget): number {
  return p.phaseIndex;
}
