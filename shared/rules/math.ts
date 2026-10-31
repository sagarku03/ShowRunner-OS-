import {
  DEFAULT_WPM,
  DRIFT_THRESHOLD,
  EMRI_MAX_PASS,
  HARMON_PHASES,
  HARMON_WEIGHT_DENOMINATOR,
  MDVI_THRESHOLD,
  OPEN_LOOP_WPM_FACTOR,
  SUB_LOOP_MAX_WPM_MULT,
  SUB_LOOP_MIN_WPM_MULT,
  WORD_TOLERANCE,
  WORDS_PER_PARAGRAPH_TARGET,
} from '../../src/config/constants.ts';

export interface HarmonPhaseBudget {
  phaseIndex: number;
  phaseId: string;
  phaseName: string;
  weight: number;
  normalizedShare: number;
  targetWords: number;
  paragraphCount: number;
}

export interface WordBudgetResult {
  targetMinutes: number;
  wpm: number;
  totalWords: number;
  targetWords: number;
  minWords: number;
  maxWords: number;
  paragraphCount: number;
  targetParagraphs: number;
  subLoopMinWords: number;
  subLoopMaxWords: number;
  openLoopMaxWordIndex: number;
  phases: HarmonPhaseBudget[];
}

export function calculateWordBudget(
  targetMinutes: number,
  wpm: number = DEFAULT_WPM,
  options?: {
    customPhases?: ReadonlyArray<{ id?: string; name: string; sharePct?: number; weight?: number }>;
    customChapterTitles?: ReadonlyArray<string>;
  }
): WordBudgetResult {
  if (!Number.isFinite(targetMinutes) || targetMinutes <= 0) {
    throw new Error(`Invalid targetMinutes: ${targetMinutes}`);
  }
  if (!Number.isFinite(wpm) || wpm <= 0) {
    throw new Error(`Invalid WPM: ${wpm}`);
  }

  const totalWords = Math.round(targetMinutes * wpm);
  const minWords = Math.round(totalWords * (1 - WORD_TOLERANCE));
  const maxWords = Math.round(totalWords * (1 + WORD_TOLERANCE));
  const paragraphCount = Math.max(1, Math.round(totalWords / WORDS_PER_PARAGRAPH_TARGET));

  const subLoopMinWords = Math.round(wpm * SUB_LOOP_MIN_WPM_MULT);
  const subLoopMaxWords = Math.round(wpm * SUB_LOOP_MAX_WPM_MULT);
  const openLoopMaxWordIndex = Math.round(wpm * OPEN_LOOP_WPM_FACTOR);

  let sourcePhases: Array<{ index: number; id: string; name: string; weight: number }>;
  let denom: number;

  if (options?.customChapterTitles && options.customChapterTitles.length > 0) {
    const titles = options.customChapterTitles.filter((t) => t.trim().length > 0);
    const equalWeight = Number((100 / titles.length).toFixed(2));
    sourcePhases = titles.map((title, idx) => ({
      index: idx + 1,
      id: `CUSTOM_CH_${idx + 1}`,
      name: title.trim(),
      weight: equalWeight,
    }));
    denom = sourcePhases.reduce((acc, p) => acc + p.weight, 0);
  } else if (options?.customPhases && options.customPhases.length > 0) {
    sourcePhases = options.customPhases.map((p, idx) => ({
      index: idx + 1,
      id: p.id || `PHASE_${idx + 1}`,
      name: p.name,
      weight: Number(p.sharePct ?? p.weight ?? 10),
    }));
    denom = sourcePhases.reduce((acc, p) => acc + p.weight, 0);
  } else {
    sourcePhases = HARMON_PHASES.map((p) => ({ ...p }));
    denom = HARMON_WEIGHT_DENOMINATOR;
  }

  let allocatedWords = 0;
  const phases: HarmonPhaseBudget[] = sourcePhases.map((phase, idx) => {
    const normalizedShare = phase.weight / denom;
    const isLast = idx === sourcePhases.length - 1;
    const phaseWords = isLast
      ? Math.max(1, totalWords - allocatedWords)
      : Math.max(1, Math.round(totalWords * normalizedShare));
    allocatedWords += phaseWords;

    const phaseParagraphs = Math.max(1, Math.round(phaseWords / WORDS_PER_PARAGRAPH_TARGET));

    return {
      phaseIndex: phase.index,
      phaseId: phase.id,
      phaseName: phase.name,
      weight: phase.weight,
      normalizedShare: Number(normalizedShare.toFixed(6)),
      targetWords: phaseWords,
      paragraphCount: phaseParagraphs,
    };
  });

  return {
    targetMinutes,
    wpm,
    totalWords,
    targetWords: totalWords,
    minWords,
    maxWords,
    paragraphCount,
    targetParagraphs: paragraphCount,
    subLoopMinWords,
    subLoopMaxWords,
    openLoopMaxWordIndex,
    phases,
  };
}

export function cosineSimilarity(vecA: ReadonlyArray<number>, vecB: ReadonlyArray<number>): number {
  if (vecA.length === 0 || vecA.length !== vecB.length) {
    throw new Error('Vectors must be non-empty and of equal dimension');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return Math.max(-1, Math.min(1, dot / denom));
}

export interface EmriEvaluation {
  cosine: number;
  emriScore: number;
  score: number;
  passed: boolean;
  maxPassThreshold: number;
}

export function computeEmriFromVectors(
  packagingVector: ReadonlyArray<number>,
  transcript30sVector: ReadonlyArray<number>,
  maxPassThreshold: number = EMRI_MAX_PASS
): EmriEvaluation {
  const cos = cosineSimilarity(packagingVector, transcript30sVector);
  const emriScore = Number((((1 - cos) / 2) * 100).toFixed(2));
  const passed = emriScore < maxPassThreshold;
  return {
    cosine: Number(cos.toFixed(6)),
    emriScore,
    score: emriScore,
    passed,
    maxPassThreshold,
  };
}

export interface MdviEvaluation {
  score: number;
  passed: boolean;
  threshold: number;
}

export function evaluateMdviScore(score: number): MdviEvaluation {
  const clamped = Math.max(0, Math.min(100, Number(score.toFixed(2))));
  return {
    score: clamped,
    passed: clamped >= MDVI_THRESHOLD,
    threshold: MDVI_THRESHOLD,
  };
}

export interface DriftEvaluation {
  targetDurationSec: number;
  actualDurationSec: number;
  driftRatio: number;
  driftPercent: number;
  driftPct: number;
  exceedsThreshold: boolean;
  drift: boolean;
  actualWpm: number;
  suggestedWpm: number;
  rollbackTo: 'S3' | null;
}

export function evaluateTranscriptDrift(params: {
  targetDurationSec: number;
  actualDurationSec: number;
  wordCount: number;
}): DriftEvaluation {
  const { targetDurationSec, actualDurationSec, wordCount } = params;
  if (targetDurationSec <= 0 || actualDurationSec <= 0) {
    throw new Error('Durations must be positive numbers');
  }
  const driftRatio = Math.abs(actualDurationSec - targetDurationSec) / targetDurationSec;
  const driftPercent = Number((driftRatio * 100).toFixed(2));
  const actualWpm = Number(((wordCount / actualDurationSec) * 60).toFixed(2));
  const exceedsThreshold = driftRatio > DRIFT_THRESHOLD;

  return {
    targetDurationSec: Number(targetDurationSec.toFixed(3)),
    actualDurationSec: Number(actualDurationSec.toFixed(3)),
    driftRatio: Number(driftRatio.toFixed(6)),
    driftPercent,
    driftPct: driftPercent,
    exceedsThreshold,
    drift: exceedsThreshold,
    actualWpm,
    suggestedWpm: actualWpm,
    rollbackTo: exceedsThreshold ? 'S3' : null,
  };
}

export function splitWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

export function splitHindiSentences(paragraph: string): string[] {
  const cleaned = paragraph.replace(/^,\s*/, '').trim();
  if (!cleaned) return [];
  return cleaned
    .split(/(?<=[।?!.])\s+|(?=[।?!.])/)
    .reduce<string[]>((acc, chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return acc;
      if (/^[।?!.]+$/.test(trimmed) && acc.length > 0) {
        acc[acc.length - 1] += trimmed;
      } else {
        acc.push(trimmed);
      }
      return acc;
    }, [])
    .map((s) => s.trim())
    .filter((s) => splitWords(s.replace(/[।?!.,]/g, '')).length > 0);
}
