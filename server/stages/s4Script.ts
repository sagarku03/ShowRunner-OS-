import type { DatabaseSync } from 'node:sqlite';
import { Type, type Schema } from '@google/genai';
import {
  BANNED_ENGLISH_PHRASES,
  BANNED_HINDI_PHRASES,
  DEFAULT_WPM,
  K_MAX_REPAIRS,
  SENTENCE_WORDS_MAX,
  SENTENCE_WORDS_MIN,
} from '../../src/config/constants.ts';
import {
  runFull17PointAudit,
  type AuditDnaOverrides,
  type AuditReport,
  type LlmSemanticJudgeOutput,
} from '../../shared/rules/audit.ts';
import {
  normaliseSpoken,
  replaceDigitsInEnglishProse,
  replaceDigitsInProse,
  validateSpokenBlock,
} from '../../shared/rules/hindiNumbers.ts';
import { splitHindiSentences, splitWords } from '../../shared/rules/math.ts';
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
import type { Stage25RuntimePayload } from './s3Arch.ts';

export interface ScriptParagraphNode {
  id: number;
  phase: string;
  chapterTitle: string;
  text: string;
  spokenText: string;
  word_count: number;
}

export interface GlossaryItem {
  term: string;
  meaning: string;
  usage: string;
}

export interface Stage3ScriptPayload {
  paragraphs: ScriptParagraphNode[];
  box1Text: string;
  box2Text: string;
  glossary: GlossaryItem[];
  auditReport: AuditReport;
  repairCount: number;
  repairLog: Array<{
    paragraphIndex: number;
    attempt: number;
    failureCode: string;
    failureReason: string;
    repairedText: string;
  }>;
  errorState?: {
    inError: boolean;
    failingParagraphIndex: number;
    failureCode: string;
    message: string;
  } | null;
}

export type Stage4ScriptPayload = Stage3ScriptPayload;

const SCRIPT_GEN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    paragraphs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.NUMBER },
          phase: { type: Type.STRING },
          chapterTitle: { type: Type.STRING },
          text: { type: Type.STRING },
          spokenText: { type: Type.STRING },
        },
        required: ['id', 'phase', 'chapterTitle', 'text', 'spokenText'],
      },
    },
    glossary: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          term: { type: Type.STRING },
          meaning: { type: Type.STRING },
          usage: { type: Type.STRING },
        },
        required: ['term', 'meaning', 'usage'],
      },
    },
  },
  required: ['paragraphs', 'glossary'],
};

const SEMANTIC_JUDGE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    fleschKincaidAsrScore: { type: Type.NUMBER },
    hook15sScore: { type: Type.NUMBER },
    emotionalEngagementScore: { type: Type.NUMBER },
    visualGroundingScore: { type: Type.NUMBER },
    noHallucinatedCitations: { type: Type.BOOLEAN },
    critique: { type: Type.STRING },
    failingParagraphIndices: {
      type: Type.ARRAY,
      items: { type: Type.NUMBER },
    },
  },
  required: [
    'fleschKincaidAsrScore',
    'hook15sScore',
    'emotionalEngagementScore',
    'visualGroundingScore',
    'noHallucinatedCitations',
    'critique',
    'failingParagraphIndices',
  ],
};

const SURGICAL_REPAIR_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    repairedParagraph: { type: Type.STRING },
    repairedSpokenParagraph: { type: Type.STRING },
  },
  required: ['repairedParagraph', 'repairedSpokenParagraph'],
};

/**
 * Deterministic mechanical cleanup applied to a single paragraph:
 * - Prepends `, ` vocal breath pause
 * - Expands digits & currencies into words of the active script (Hindi Devanagari or English Latin)
 * - Strips banned clichés
 */
export function normalizeSingleParagraphMechanics(
  rawPara: string,
  script: string = 'Devanagari',
  extraBanned: ReadonlyArray<string> = []
): string {
  const isLatin = script.toLowerCase() === 'latin';
  let cleaned = isLatin
    ? replaceDigitsInEnglishProse((rawPara || '').trim())
    : replaceDigitsInProse((rawPara || '').trim());

  const bannedList = isLatin
    ? [...BANNED_ENGLISH_PHRASES, ...extraBanned]
    : [...BANNED_HINDI_PHRASES, ...extraBanned];

  for (const banned of bannedList) {
    if (banned) {
      cleaned = cleaned.split(banned).join(isLatin ? 'demonstrated' : 'स्पष्ट किया');
    }
  }
  if (!cleaned.startsWith(', ')) {
    cleaned = `, ${cleaned.replace(/^,+\s*/, '')}`;
  }
  return cleaned;
}

function applyUserGlossaryToSpoken(
  db: DatabaseSync,
  projectId: string,
  text: string,
  script: string
): string {
  const rows = db
    .prepare(
      `SELECT english_term, hinglish_spelling, devanagari_text
       FROM phonetic_glossary
       WHERE project_id = ? OR project_id IS NULL`
    )
    .all(projectId) as Array<{
    english_term: string;
    hinglish_spelling: string | null;
    devanagari_text: string;
  }>;

  let out = text;
  for (const row of rows) {
    const replacement =
      script.toLowerCase() === 'latin'
        ? row.hinglish_spelling || row.devanagari_text || row.english_term
        : row.devanagari_text;
    if (row.english_term && replacement) {
      out = out.split(row.english_term).join(replacement);
    }
  }
  return out;
}

function resolveAuditContextForProject(db: DatabaseSync, projectId: string): {
  targetMinutes: number;
  wpm: number;
  brandName: string;
  targetScript: string;
  mergedBannedWords: string[];
  dnaOverrides: AuditDnaOverrides;
} {
  const proj = db
    .prepare(`SELECT target_duration, configured_wpm, brand_name FROM projects WHERE id = ?`)
    .get(projectId) as
    | { target_duration: number; configured_wpm: number; brand_name: string }
    | undefined;

  const lockedDna = getLockedChannelDna(db, projectId)?.dna;
  const masterState = getMasterPromptState(db, projectId);
  const targetScript = lockedDna?.language.script || 'Devanagari';
  const brandName =
    masterState.extracted.brandName || proj?.brand_name || 'FactLock';

  const baseBanned =
    targetScript.toLowerCase() === 'latin'
      ? [...BANNED_HINDI_PHRASES, ...BANNED_ENGLISH_PHRASES]
      : [...BANNED_HINDI_PHRASES];

  const mergedBannedWords = Array.from(
    new Set([
      ...baseBanned,
      ...masterState.extracted.bannedWords,
      ...(lockedDna?.voice.bannedWords ?? []),
    ])
  ).filter(Boolean);

  return {
    targetMinutes: proj?.target_duration || 11,
    wpm: proj?.configured_wpm || DEFAULT_WPM,
    brandName,
    targetScript,
    mergedBannedWords,
    dnaOverrides: {
      sentenceLen: lockedDna?.voice.sentenceLen ?? [SENTENCE_WORDS_MIN, SENTENCE_WORDS_MAX],
      paragraphWords: lockedDna?.voice.paragraphWords ?? null,
      hookSeconds: lockedDna?.structure.hookSeconds ?? null,
      script: targetScript,
      bannedWords: mergedBannedWords,
      mustUsePhrases: lockedDna?.voice.mustUsePhrases ?? null,
    },
  };
}

function renderScriptBoxes(paragraphs: ScriptParagraphNode[]): {
  box1Text: string;
  box2Text: string;
} {
  return {
    box1Text: paragraphs.map((p) => p.text.trim()).join('\n\n'),
    box2Text: paragraphs.map((p) => p.spokenText.trim()).join('\n\n'),
  };
}

export async function evaluateSemanticJudge(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string,
  scriptText: string,
  verifiedClaimsSummary: string
): Promise<LlmSemanticJudgeOutput | null> {
  const systemInstruction = [
    'You are the 17-Point Audit Semantic Judge (Checks C13-C17) for ShowRunner OS v1.3.1.',
    'Evaluate the script against verified research claims and score:',
    '- fleschKincaidAsrScore (0-100, >= 75 passes)',
    '- hook15sScore (0-100, >= 80 passes)',
    '- emotionalEngagementScore (0-100, >= 75 passes)',
    '- visualGroundingScore (0-100, >= 75 passes)',
    '- noHallucinatedCitations (boolean)',
  ].join(' ');

  try {
    const res = await gemini.generateStructured<LlmSemanticJudgeOutput>({
      db,
      projectId,
      stage: 'S3_JUDGE',
      tier: 'TIER_FAST',
      systemInstruction,
      userPrompt: `Verified Claims:\n${verifiedClaimsSummary}\n\nScript:\n${scriptText}`,
      responseSchema: SEMANTIC_JUDGE_SCHEMA,
      temperature: 0.1,
    });
    return res.data;
  } catch {
    // Per G9: NEVER silently pass semantic checks when the LLM judge fails.
    return null;
  }
}

/**
 * Tri-Node Surgical Repair for a single paragraph k:
 * Passes { previous_paragraph, failing_paragraph, next_paragraph, failure_reason }
 * to TIER_REASONING and grafts ONLY paragraph k back into the array.
 */
export async function callTriNodeRepairLlm(params: {
  db: DatabaseSync;
  gemini: GeminiGateway;
  projectId: string;
  paragraphIndex: number;
  previousParagraph: string;
  failingParagraph: string;
  nextParagraph: string;
  failureCode: string;
  failureReason: string;
  attempt: number;
  script?: string;
  sentenceBounds?: readonly [number, number];
  extraBanned?: ReadonlyArray<string>;
}): Promise<{ repairedText: string; repairedSpokenText: string }> {
  const targetScript = params.script || 'Devanagari';
  const sMin = params.sentenceBounds?.[0] ?? SENTENCE_WORDS_MIN;
  const sMax = params.sentenceBounds?.[1] ?? SENTENCE_WORDS_MAX;

  const systemInstruction = [
    'You are the Tri-Node Surgical Script Repair Engine for ShowRunner OS v1.3.0.',
    'You receive ONLY { previous_paragraph, failing_paragraph, next_paragraph, failure_reason }.',
    'Rewrite ONLY failing_paragraph so that it seamlessly bridges previous_paragraph and next_paragraph while fixing failure_reason.',
    'Rules:',
    '1. Start with a leading ", " vocal breath pause.',
    `2. Every sentence MUST contain between ${sMin} and ${sMax} words.`,
    `3. Write all numbers and currencies in ${targetScript} words (zero digits 0-9).`,
    `4. For repairedSpokenParagraph (Box 2 TTS), comply strictly with ${targetScript} orthography.`,
    '5. Never use banned phrases.',
  ].join(' ');

  const triNodePayload = {
    previous_paragraph: params.previousParagraph,
    failing_paragraph: params.failingParagraph,
    next_paragraph: params.nextParagraph,
    failure_reason: `[${params.failureCode}] ${params.failureReason}`,
  };

  const repairRes = await params.gemini.generateStructured<{
    repairedParagraph: string;
    repairedSpokenParagraph: string;
  }>({
    db: params.db,
    projectId: params.projectId,
    stage: 'S3_REPAIR',
    tier: 'TIER_REASONING',
    systemInstruction,
    userPrompt: JSON.stringify(triNodePayload, null, 2),
    responseSchema: SURGICAL_REPAIR_SCHEMA,
    temperature: 0.2,
  });

  const repairedText = normalizeSingleParagraphMechanics(
    repairRes.data.repairedParagraph || params.failingParagraph,
    targetScript,
    params.extraBanned
  );
  const withGlossary = applyUserGlossaryToSpoken(
    params.db,
    params.projectId,
    repairRes.data.repairedSpokenParagraph || repairedText,
    targetScript
  );
  const repairedSpokenText = normaliseSpoken(withGlossary, targetScript);

  params.db
    .prepare(
      `INSERT INTO repair_attempts
       (project_id, stage_id, paragraph_index, attempt_number, failure_code, original_text, repaired_text, succeeded)
       VALUES (?, 'S3', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.projectId,
      params.paragraphIndex,
      params.attempt,
      params.failureCode,
      params.failingParagraph,
      repairedText,
      1
    );

  return { repairedText, repairedSpokenText };
}

export async function handleGenerateAndAuditScript(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string
): Promise<Stage3ScriptPayload> {
  assertStageUnlocked(db, projectId, 'S3');

  const ctx = resolveAuditContextForProject(db, projectId);
  const { targetMinutes, wpm, brandName, targetScript, mergedBannedWords, dnaOverrides } = ctx;
  const lockedDna = getLockedChannelDna(db, projectId)?.dna;

  const s2Row = getStageRow(db, projectId, 'S2');
  const s25Row = getStageRow(db, projectId, 'S2.5');
  if (!s2Row || !s25Row) {
    throw new Error('Upstream Research (S2) or Runtime Architecture (S2.5) missing.');
  }

  const s2 = JSON.parse(s2Row.payload_json) as Stage2ResearchPayload;
  const s25 = JSON.parse(s25Row.payload_json) as Stage25RuntimePayload;

  const masterBlock = buildMasterPromptInjectionBlock(db, projectId);
  const dnaBlock = buildChannelDnaPromptBlock(lockedDna, 'S3');
  const sMin = dnaOverrides.sentenceLen?.[0] ?? SENTENCE_WORDS_MIN;
  const sMax = dnaOverrides.sentenceLen?.[1] ?? SENTENCE_WORDS_MAX;

  const systemInstruction = [
    'You are the Stage 3 Dual-Output Script Engine & Phonetic Architect for ShowRunner OS v1.3.0.',
    `Generate an indexed JSON array of ${s25.wordBudget.paragraphCount} paragraphs across the ${s25.chapters.length} chapters totaling ${s25.wordBudget.totalWords} words (±5%: ${s25.wordBudget.minWords} to ${s25.wordBudget.maxWords} words).`,
    'Mandatory 17-Point Rules:',
    '- Every paragraph MUST start with a leading ", " pause.',
    `- Every sentence MUST contain between ${sMin} and ${sMax} words.`,
    `- ZERO Arabic digits (0-9); write all numbers and currencies in ${targetScript} words.`,
    `- spokenText (Box 2) MUST comply with ${targetScript} phonetic orthography.`,
    `- Include the brand name "${brandName}" only in the final payoff paragraph.`,
    '- Include a curiosity open loop within the first 45 seconds.',
    `- Never use banned phrases: ${mergedBannedWords.join(', ')}.`,
    dnaBlock,
    masterBlock,
  ].join('\n');

  const verifiedSummary = (s2.verifiedClaims || [])
    .map((c) => `- [${c.id}] ${c.claim} (${c.institution}, ${c.year})`)
    .join('\n');

  const chaptersSummary = (s25.chapters || [])
    .map(
      (c) =>
        `Phase ${c.phaseIndex} (${c.phaseName} - "${c.chapterTitle}"): ${c.targetWords} words (${c.paragraphCount} paragraphs)`
    )
    .join('\n');

  const userPrompt = [
    `Topic: ${s2.topicTitle}`,
    `Brand Name: ${brandName}`,
    `Selected Metaphor: ${s25.selectedMetaphor.metaphor}`,
    `Target Budget: ${s25.wordBudget.totalWords} words across ${s25.wordBudget.paragraphCount} paragraphs`,
    `Chapter Plan:\n${chaptersSummary}`,
    `Verified Claims:\n${verifiedSummary}`,
  ].join('\n\n');

  const genRes = await gemini.generateStructured<{
    paragraphs: Array<{
      id: number;
      phase: string;
      chapterTitle: string;
      text: string;
      spokenText?: string;
    }>;
    glossary?: GlossaryItem[];
  }>({
    db,
    projectId,
    stage: 'S3',
    tier: 'TIER_REASONING',
    systemInstruction,
    userPrompt,
    responseSchema: SCRIPT_GEN_SCHEMA,
    temperature: 0.4,
  });

  const rawParagraphs = Array.isArray(genRes.data.paragraphs) ? genRes.data.paragraphs : [];
  const paragraphs: ScriptParagraphNode[] = rawParagraphs.map((p, idx) => {
    const cleanText = normalizeSingleParagraphMechanics(p.text, targetScript, mergedBannedWords);
    const glossaryApplied = applyUserGlossaryToSpoken(
      db,
      projectId,
      p.spokenText || cleanText,
      targetScript
    );
    const cleanSpoken = normaliseSpoken(glossaryApplied, targetScript);
    return {
      id: idx,
      phase: p.phase || s25.chapters[idx % s25.chapters.length]?.phaseName || `Phase ${idx + 1}`,
      chapterTitle:
        p.chapterTitle || s25.chapters[idx % s25.chapters.length]?.chapterTitle || `Chapter ${idx + 1}`,
      text: cleanText,
      spokenText: cleanSpoken,
      word_count: splitWords(cleanText).length,
    };
  });

  const repairLog: Stage3ScriptPayload['repairLog'] = [];
  let totalRepairAttempts = 0;

  // Step 1: Check Box 2 spokenText for any residual script/digit violations (G10) and route through bounded tri-node repair
  for (let i = 0; i < paragraphs.length; i++) {
    let spokenCheck = validateSpokenBlock(paragraphs[i].spokenText, targetScript);
    let attempt = 0;
    while (!spokenCheck.valid && spokenCheck.reason === 'LATIN_TOKEN' && attempt < K_MAX_REPAIRS) {
      attempt += 1;
      totalRepairAttempts += 1;
      const repaired = await callTriNodeRepairLlm({
        db,
        gemini,
        projectId,
        paragraphIndex: i,
        previousParagraph: i > 0 ? paragraphs[i - 1].spokenText : '',
        failingParagraph: paragraphs[i].spokenText,
        nextParagraph: i < paragraphs.length - 1 ? paragraphs[i + 1].spokenText : '',
        failureCode: 'LATIN_TOKEN',
        failureReason: `Box 2 spokenText contains Latin tokens: ${spokenCheck.offendingTokens.join(', ')}. Transliterate into pure ${targetScript}.`,
        attempt,
        script: targetScript,
        sentenceBounds: dnaOverrides.sentenceLen ?? undefined,
        extraBanned: mergedBannedWords,
      });
      paragraphs[i].text = repaired.repairedText;
      paragraphs[i].spokenText = repaired.repairedSpokenText;
      paragraphs[i].word_count = splitWords(repaired.repairedText).length;
      repairLog.push({
        paragraphIndex: i,
        attempt,
        failureCode: 'LATIN_TOKEN',
        failureReason: `Offending Latin tokens: ${spokenCheck.offendingTokens.join(', ')}`,
        repairedText: repaired.repairedSpokenText,
      });
      spokenCheck = validateSpokenBlock(paragraphs[i].spokenText, targetScript);
    }
  }

  let { box1Text, box2Text } = renderScriptBoxes(paragraphs);
  let judgeOutput = await evaluateSemanticJudge(db, gemini, projectId, box1Text, verifiedSummary);
  let auditReport = runFull17PointAudit({
    scriptText: box1Text,
    box2Text,
    targetMinutes,
    wpm,
    brandName,
    bannedWords: mergedBannedWords,
    dna: dnaOverrides,
    llmJudge: judgeOutput,
  });

  // Step 2: Bounded Tri-Node Surgical Repair loop (max K_MAX_REPAIRS = 3 per failure)
  let errorState: Stage3ScriptPayload['errorState'] = null;
  const perParagraphAttempts = new Map<number, number>();

  while (
    !auditReport.allPassed &&
    auditReport.auditStatus !== 'JUDGE_UNAVAILABLE'
  ) {
    const failedCheck = auditReport.checks.find(
      (c) => c.status === 'FAIL' && c.failingParagraphIndices.length > 0
    );
    if (!failedCheck) {
      break;
    }

    const pIdx = failedCheck.failingParagraphIndices[0];
    if (pIdx < 0 || pIdx >= paragraphs.length) {
      break;
    }

    const prevAttempts = perParagraphAttempts.get(pIdx) ?? 0;
    if (prevAttempts >= K_MAX_REPAIRS) {
      errorState = {
        inError: true,
        failingParagraphIndex: pIdx,
        failureCode: failedCheck.code,
        message: `Tri-Node Surgical Repair exhausted K_MAX_REPAIRS (${K_MAX_REPAIRS}) on paragraph #${pIdx + 1} (${failedCheck.code}: ${failedCheck.detail}). Manual edit required.`,
      };
      break;
    }

    const nextAttempt = prevAttempts + 1;
    perParagraphAttempts.set(pIdx, nextAttempt);
    totalRepairAttempts += 1;

    const repaired = await callTriNodeRepairLlm({
      db,
      gemini,
      projectId,
      paragraphIndex: pIdx,
      previousParagraph: pIdx > 0 ? paragraphs[pIdx - 1].text : '',
      failingParagraph: paragraphs[pIdx].text,
      nextParagraph: pIdx < paragraphs.length - 1 ? paragraphs[pIdx + 1].text : '',
      failureCode: failedCheck.code,
      failureReason: failedCheck.detail,
      attempt: nextAttempt,
      script: targetScript,
      sentenceBounds: dnaOverrides.sentenceLen ?? undefined,
      extraBanned: mergedBannedWords,
    });

    paragraphs[pIdx].text = repaired.repairedText;
    paragraphs[pIdx].spokenText = repaired.repairedSpokenText;
    paragraphs[pIdx].word_count = splitWords(repaired.repairedText).length;

    repairLog.push({
      paragraphIndex: pIdx,
      attempt: nextAttempt,
      failureCode: failedCheck.code,
      failureReason: failedCheck.detail,
      repairedText: repaired.repairedText,
    });

    ({ box1Text, box2Text } = renderScriptBoxes(paragraphs));
    judgeOutput = await evaluateSemanticJudge(db, gemini, projectId, box1Text, verifiedSummary);
    auditReport = runFull17PointAudit({
      scriptText: box1Text,
      box2Text,
      targetMinutes,
      wpm,
      brandName,
      bannedWords: mergedBannedWords,
      dna: dnaOverrides,
      llmJudge: judgeOutput,
    });
  }

  const payload: Stage3ScriptPayload = {
    paragraphs,
    box1Text,
    box2Text,
    glossary: Array.isArray(genRes.data.glossary) ? genRes.data.glossary : [],
    auditReport,
    repairCount: totalRepairAttempts,
    repairLog,
    errorState,
  };

  if (errorState?.inError) {
    db.prepare(`UPDATE projects SET active_state = 'S_error', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      projectId
    );
  }

  commitStageState(db, {
    projectId,
    stageId: 'S3',
    payload,
    status: auditReport.allPassed ? 'PASSED' : 'FAILED',
  });

  return payload;
}

export async function handleAuditExistingScript(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string
): Promise<Stage3ScriptPayload> {
  const s3Row = getStageRow(db, projectId, 'S3');
  if (!s3Row) {
    throw new Error('Stage 3 script not found.');
  }

  const payload = JSON.parse(s3Row.payload_json) as Stage3ScriptPayload;
  const ctx = resolveAuditContextForProject(db, projectId);

  const s2Row = getStageRow(db, projectId, 'S2');
  const s2 = s2Row ? (JSON.parse(s2Row.payload_json) as Stage2ResearchPayload) : null;
  const verifiedSummary = (s2?.verifiedClaims || []).map((c) => c.claim).join('\n');

  const { box1Text, box2Text } = renderScriptBoxes(payload.paragraphs);
  const judgeOutput = await evaluateSemanticJudge(db, gemini, projectId, box1Text, verifiedSummary);
  const auditReport = runFull17PointAudit({
    scriptText: box1Text,
    box2Text,
    targetMinutes: ctx.targetMinutes,
    wpm: ctx.wpm,
    brandName: ctx.brandName,
    bannedWords: ctx.mergedBannedWords,
    dna: ctx.dnaOverrides,
    llmJudge: judgeOutput,
  });

  payload.box1Text = box1Text;
  payload.box2Text = box2Text;
  payload.auditReport = auditReport;
  if (auditReport.allPassed) {
    payload.errorState = null;
  }

  commitStageState(db, {
    projectId,
    stageId: 'S3',
    payload,
    status: auditReport.allPassed ? 'PASSED' : 'FAILED',
  });

  return payload;
}

export async function handleSurgicalRepairEndpoint(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string,
  input: {
    paragraphIndex?: number;
    manualText?: string;
    manualSpokenText?: string;
  }
): Promise<Stage3ScriptPayload> {
  const s3Row = getStageRow(db, projectId, 'S3');
  if (!s3Row) {
    throw new Error('Stage 3 script not found.');
  }

  const payload = JSON.parse(s3Row.payload_json) as Stage3ScriptPayload;
  const ctx = resolveAuditContextForProject(db, projectId);

  const s2Row = getStageRow(db, projectId, 'S2');
  const s2 = s2Row ? (JSON.parse(s2Row.payload_json) as Stage2ResearchPayload) : null;
  const verifiedSummary = (s2?.verifiedClaims || []).map((c) => c.claim).join('\n');

  if (typeof input.manualText === 'string' && typeof input.paragraphIndex === 'number') {
    const idx = input.paragraphIndex;
    if (idx >= 0 && idx < payload.paragraphs.length) {
      const cleanText = normalizeSingleParagraphMechanics(
        input.manualText,
        ctx.targetScript,
        ctx.mergedBannedWords
      );
      const cleanSpoken = normaliseSpoken(
        input.manualSpokenText || cleanText,
        ctx.targetScript
      );
      payload.paragraphs[idx].text = cleanText;
      payload.paragraphs[idx].spokenText = cleanSpoken;
      payload.paragraphs[idx].word_count = splitWords(cleanText).length;
    }
  } else {
    const failedCheck =
      (typeof input.paragraphIndex === 'number'
        ? payload.auditReport.checks.find(
            (c) => c.status === 'FAIL' && c.failingParagraphIndices.includes(input.paragraphIndex!)
          )
        : undefined) ??
      payload.auditReport.checks.find(
        (c) => c.status === 'FAIL' && c.failingParagraphIndices.length > 0
      );
    const targetIdx =
      typeof input.paragraphIndex === 'number'
        ? input.paragraphIndex
        : failedCheck?.failingParagraphIndices[0] ?? 0;

    if (targetIdx < 0 || targetIdx >= payload.paragraphs.length) {
      throw new Error(`Paragraph index ${targetIdx} out of bounds.`);
    }

    const existingAttemptsForPara = payload.repairLog.filter(
      (r) => r.paragraphIndex === targetIdx
    ).length;

    if (existingAttemptsForPara >= K_MAX_REPAIRS) {
      payload.errorState = {
        inError: true,
        failingParagraphIndex: targetIdx,
        failureCode: failedCheck?.code || 'C03',
        message: `Tri-Node Surgical Repair exceeded K_MAX_REPAIRS (${K_MAX_REPAIRS}) for paragraph #${targetIdx + 1}. Please use manual paragraph edit.`,
      };
      db.prepare(`UPDATE projects SET active_state = 'S_error', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        projectId
      );
      commitStageState(db, {
        projectId,
        stageId: 'S3',
        payload,
        status: 'FAILED',
      });
      return payload;
    }

    const attempt = existingAttemptsForPara + 1;
    const repaired = await callTriNodeRepairLlm({
      db,
      gemini,
      projectId,
      paragraphIndex: targetIdx,
      previousParagraph: targetIdx > 0 ? payload.paragraphs[targetIdx - 1].text : '',
      failingParagraph: payload.paragraphs[targetIdx].text,
      nextParagraph:
        targetIdx < payload.paragraphs.length - 1 ? payload.paragraphs[targetIdx + 1].text : '',
      failureCode: failedCheck?.code || 'C03',
      failureReason:
        failedCheck?.detail ||
        `Ensure every sentence has ${SENTENCE_WORDS_MIN}-${SENTENCE_WORDS_MAX} words and starts with ", ".`,
      attempt,
      script: ctx.targetScript,
      sentenceBounds: ctx.dnaOverrides.sentenceLen ?? undefined,
      extraBanned: ctx.mergedBannedWords,
    });

    payload.paragraphs[targetIdx].text = repaired.repairedText;
    payload.paragraphs[targetIdx].spokenText = repaired.repairedSpokenText;
    payload.paragraphs[targetIdx].word_count = splitWords(repaired.repairedText).length;
    payload.repairCount += 1;
    payload.repairLog.push({
      paragraphIndex: targetIdx,
      attempt,
      failureCode: failedCheck?.code || 'C03',
      failureReason: failedCheck?.detail || 'Surgical repair',
      repairedText: repaired.repairedText,
    });
  }

  const { box1Text, box2Text } = renderScriptBoxes(payload.paragraphs);
  const judgeOutput = await evaluateSemanticJudge(db, gemini, projectId, box1Text, verifiedSummary);
  const auditReport = runFull17PointAudit({
    scriptText: box1Text,
    box2Text,
    targetMinutes: ctx.targetMinutes,
    wpm: ctx.wpm,
    brandName: ctx.brandName,
    bannedWords: ctx.mergedBannedWords,
    dna: ctx.dnaOverrides,
    llmJudge: judgeOutput,
  });

  payload.box1Text = box1Text;
  payload.box2Text = box2Text;
  payload.auditReport = auditReport;
  if (auditReport.allPassed) {
    payload.errorState = null;
  }

  commitStageState(db, {
    projectId,
    stageId: 'S3',
    payload,
    status: auditReport.allPassed ? 'PASSED' : 'FAILED',
  });
  invalidateDownstreamStages(db, projectId, 'S3');

  return payload;
}

export function extractSentenceListHelper(text: string): string[] {
  return splitHindiSentences(text);
}
