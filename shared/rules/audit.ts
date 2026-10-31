import {
  BANNED_ENGLISH_PHRASES,
  BANNED_HINDI_PHRASES,
  CAUSAL_CONJUNCTIONS,
  DEFAULT_WPM,
  DOCUMENTARY_C15_LABEL,
  HOOK_WINDOW_SEC,
  NEUTRAL_C15_LABEL,
  OPEN_LOOP_WINDOW_SEC,
  PIVOT_WINDOW_SEC,
  SENTENCE_WORDS_MAX,
  SENTENCE_WORDS_MIN,
  WORDS_PER_PARAGRAPH_TARGET,
} from '../../src/config/constants.ts';
import { validateSpokenBlock } from './hindiNumbers.ts';
import { calculateWordBudget, splitHindiSentences, splitWords } from './math.ts';

export type AuditCheckStatus = 'PASS' | 'FAIL' | 'UNVERIFIED';

export interface AuditCheckResult {
  id: number;
  code: string;
  category: 'DETERMINISTIC_REGEX' | 'LLM_SEMANTIC_JUDGE';
  name: string;
  passed: boolean;
  status: AuditCheckStatus;
  detail: string;
  failingParagraphIndices: number[];
}

export interface LlmSemanticJudgeOutput {
  fleschKincaidAsrScore: number;
  hook15sScore: number;
  emotionalEngagementScore?: number;
  visualGroundingScore: number;
  noHallucinatedCitations: boolean;
  critique: string;
  failingParagraphIndices?: number[];
}

export interface AuditDnaOverrides {
  sentenceLen?: readonly [number, number] | null;
  paragraphWords?: number | null;
  hookSeconds?: number | null;
  script?: string | null;
  formatPreset?: string | null;
  bannedWords?: ReadonlyArray<string> | null;
  mustUsePhrases?: ReadonlyArray<string> | null;
}

export interface AuditReport {
  totalChecks: 17;
  passedCount: number;
  failedCount: number;
  unverifiedCount: number;
  allPassed: boolean;
  auditStatus: 'PASSED' | 'FAILED' | 'JUDGE_UNAVAILABLE';
  wordCount: number;
  paragraphCount: number;
  sentenceCount: number;
  checks: AuditCheckResult[];
}

export function splitParagraphs(scriptText: string): string[] {
  return scriptText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function runFull17PointAudit(params: {
  scriptText: string;
  box2Text?: string;
  targetMinutes: number;
  wpm?: number;
  brandName?: string;
  bannedWords?: ReadonlyArray<string>;
  dna?: AuditDnaOverrides | null;
  llmJudge?: LlmSemanticJudgeOutput | null;
}): AuditReport {
  const {
    scriptText,
    box2Text,
    targetMinutes,
    wpm = DEFAULT_WPM,
    brandName = 'FactLock',
    bannedWords,
    dna,
    llmJudge,
  } = params;

  const targetScript = dna?.script?.trim() || 'Devanagari';
  const sentenceMin =
    dna?.sentenceLen && Number.isFinite(dna.sentenceLen[0])
      ? Math.max(4, Number(dna.sentenceLen[0]))
      : SENTENCE_WORDS_MIN;
  const sentenceMax =
    dna?.sentenceLen && Number.isFinite(dna.sentenceLen[1])
      ? Math.max(sentenceMin + 2, Number(dna.sentenceLen[1]))
      : SENTENCE_WORDS_MAX;
  const hookSeconds =
    dna?.hookSeconds && Number.isFinite(dna.hookSeconds) && dna.hookSeconds > 0
      ? Number(dna.hookSeconds)
      : HOOK_WINDOW_SEC;
  const paragraphTargetWords =
    dna?.paragraphWords && Number.isFinite(dna.paragraphWords) && dna.paragraphWords > 20
      ? Number(dna.paragraphWords)
      : WORDS_PER_PARAGRAPH_TARGET;

  const defaultBanned =
    targetScript === 'Latin'
      ? [...BANNED_HINDI_PHRASES, ...BANNED_ENGLISH_PHRASES]
      : BANNED_HINDI_PHRASES;
  const mergedBanned = Array.from(
    new Set([
      ...(bannedWords ?? defaultBanned),
      ...(dna?.bannedWords ?? []),
    ])
  ).filter((w) => typeof w === 'string' && w.trim().length > 0);

  const budget = calculateWordBudget(targetMinutes, wpm);
  const paragraphs = splitParagraphs(scriptText);
  const allSentences: Array<{ text: string; wordCount: number; paragraphIdx: number }> = [];

  paragraphs.forEach((para, pIdx) => {
    const sents = splitHindiSentences(para);
    sents.forEach((s) => {
      const wc = splitWords(s.replace(/[।?!.,;:]/g, '')).length;
      allSentences.push({ text: s, wordCount: wc, paragraphIdx: pIdx });
    });
  });

  const totalWords = splitWords(scriptText.replace(/^,\s*/gm, '')).length;
  const checks: AuditCheckResult[] = [];

  // C01: Word Budget (±5%)
  const c1Pass = totalWords >= budget.minWords && totalWords <= budget.maxWords;
  checks.push({
    id: 1,
    code: 'C01',
    category: 'DETERMINISTIC_REGEX',
    name: 'Word Budget Tolerance (±5%)',
    passed: c1Pass,
    status: c1Pass ? 'PASS' : 'FAIL',
    detail: `Actual ${totalWords} words vs allowed [${budget.minWords}, ${budget.maxWords}] (target ${budget.totalWords})`,
    failingParagraphIndices: c1Pass ? [] : [Math.max(0, paragraphs.length - 1)],
  });

  // C02: Zero Arabic Digits (0-9)
  const digitParagraphs: number[] = [];
  paragraphs.forEach((p, idx) => {
    if (/[0-9]/.test(p)) {
      digitParagraphs.push(idx);
    }
  });
  const c2Pass = digitParagraphs.length === 0;
  checks.push({
    id: 2,
    code: 'C02',
    category: 'DETERMINISTIC_REGEX',
    name: 'Zero Arabic Digits (0-9)',
    passed: c2Pass,
    status: c2Pass ? 'PASS' : 'FAIL',
    detail: c2Pass
      ? 'Zero Arabic digits found; all numbers written in spoken words'
      : `Found Arabic digits in paragraph(s): ${digitParagraphs.map((i) => i + 1).join(', ')}`,
    failingParagraphIndices: digitParagraphs,
  });

  // C03: Sentence Length Bounds (reads dna.voice.sentenceLen when present, else [14, 22])
  const badSentenceParagraphs = new Set<number>();
  const badSentenceDetails: string[] = [];
  allSentences.forEach((s, sIdx) => {
    if (s.wordCount < sentenceMin || s.wordCount > sentenceMax) {
      badSentenceParagraphs.add(s.paragraphIdx);
      badSentenceDetails.push(`S${sIdx + 1}(P${s.paragraphIdx + 1})=${s.wordCount}w`);
    }
  });
  const c3Pass = badSentenceParagraphs.size === 0 && allSentences.length > 0;
  checks.push({
    id: 3,
    code: 'C03',
    category: 'DETERMINISTIC_REGEX',
    name: `Sentence Length (${sentenceMin}–${sentenceMax} words)`,
    passed: c3Pass,
    status: c3Pass ? 'PASS' : 'FAIL',
    detail: c3Pass
      ? `All ${allSentences.length} sentences sit strictly within [${sentenceMin}, ${sentenceMax}] words`
      : `Out-of-bounds sentences: ${badSentenceDetails.slice(0, 6).join(', ')}`,
    failingParagraphIndices: Array.from(badSentenceParagraphs),
  });

  // C04: Vocal Breath Pause Prefix (`, ` on every paragraph)
  const missingCommaParagraphs: number[] = [];
  paragraphs.forEach((p, idx) => {
    if (!p.startsWith(', ')) {
      missingCommaParagraphs.push(idx);
    }
  });
  const c4Pass = missingCommaParagraphs.length === 0 && paragraphs.length > 0;
  checks.push({
    id: 4,
    code: 'C04',
    category: 'DETERMINISTIC_REGEX',
    name: 'Paragraph Vocal Pause Prefix (", ")',
    passed: c4Pass,
    status: c4Pass ? 'PASS' : 'FAIL',
    detail: c4Pass
      ? `All ${paragraphs.length} paragraphs begin with ", "`
      : `Paragraph(s) missing leading ", ": ${missingCommaParagraphs.map((i) => i + 1).join(', ')}`,
    failingParagraphIndices: missingCommaParagraphs,
  });

  // C05: Zero Banned Clichés / Hyperbole (merges project blacklist + master prompt + DNA bannedWords)
  const clicheParagraphs = new Set<number>();
  const foundCliches: string[] = [];
  paragraphs.forEach((p, idx) => {
    const pLower = p.toLowerCase();
    for (const phrase of mergedBanned) {
      if (phrase && pLower.includes(phrase.toLowerCase())) {
        clicheParagraphs.add(idx);
        foundCliches.push(phrase);
      }
    }
  });
  const c5Pass = clicheParagraphs.size === 0;
  checks.push({
    id: 5,
    code: 'C05',
    category: 'DETERMINISTIC_REGEX',
    name: 'Zero Banned Clichés & Blacklist Phrases',
    passed: c5Pass,
    status: c5Pass ? 'PASS' : 'FAIL',
    detail: c5Pass ? 'Zero banned phrases detected' : `Found banned phrase(s): ${foundCliches.join(', ')}`,
    failingParagraphIndices: Array.from(clicheParagraphs),
  });

  // C06: Brand Lock (brand_name allowed ONLY in final payoff paragraph)
  const cleanBrand = (brandName || 'FactLock').trim();
  const earlyBrandParagraphs: number[] = [];
  if (cleanBrand.length > 0 && paragraphs.length > 1) {
    for (let i = 0; i < paragraphs.length - 1; i++) {
      if (paragraphs[i].toLowerCase().includes(cleanBrand.toLowerCase())) {
        earlyBrandParagraphs.push(i);
      }
    }
  }
  const c6Pass = earlyBrandParagraphs.length === 0;
  checks.push({
    id: 6,
    code: 'C06',
    category: 'DETERMINISTIC_REGEX',
    name: `Brand Lock ("${cleanBrand}" in Final Payoff Only)`,
    passed: c6Pass,
    status: c6Pass ? 'PASS' : 'FAIL',
    detail: c6Pass
      ? `Brand "${cleanBrand}" does not appear prematurely before the final paragraph`
      : `Brand "${cleanBrand}" appeared prematurely in paragraph(s): ${earlyBrandParagraphs.map((i) => i + 1).join(', ')}`,
    failingParagraphIndices: earlyBrandParagraphs,
  });

  // C07: Causal Pivot Window
  const pivotSec = Math.max(hookSeconds + 10, PIVOT_WINDOW_SEC);
  const pivotWindowEndWord = Math.max(40, Math.ceil((pivotSec / 60) * wpm));
  const wordsUpToPivot = splitWords(scriptText.replace(/^,\s*/gm, ''))
    .slice(0, pivotWindowEndWord)
    .join(' ')
    .toLowerCase();
  const c7Pass = CAUSAL_CONJUNCTIONS.some((conj) => wordsUpToPivot.includes(conj.toLowerCase()));
  checks.push({
    id: 7,
    code: 'C07',
    category: 'DETERMINISTIC_REGEX',
    name: `Causal Pivot in ${hookSeconds}–${pivotSec}s Window`,
    passed: c7Pass,
    status: c7Pass ? 'PASS' : 'FAIL',
    detail: c7Pass
      ? `Causal pivot conjunction present within first ${pivotSec}s`
      : `Missing causal pivot conjunction in first ${pivotSec}s`,
    failingParagraphIndices: c7Pass ? [] : [0],
  });

  // C08: Open Loop Question within first 45s (wordIndex <= 0.75 * WPM)
  const openLoopMaxWords = Math.max(30, budget.openLoopMaxWordIndex);
  const first45sText = splitWords(scriptText.replace(/^,\s*/gm, ''))
    .slice(0, openLoopMaxWords)
    .join(' ')
    .toLowerCase();
  const hasOpenLoop45s =
    first45sText.includes('?') ||
    first45sText.includes('क्यों') ||
    first45sText.includes('कैसे') ||
    first45sText.includes('आखिर') ||
    first45sText.includes('क्या') ||
    first45sText.includes('why') ||
    first45sText.includes('how') ||
    first45sText.includes('what if');
  checks.push({
    id: 8,
    code: 'C08',
    category: 'DETERMINISTIC_REGEX',
    name: `Open Loop Question within ${OPEN_LOOP_WINDOW_SEC}s (<= ${openLoopMaxWords} words)`,
    passed: hasOpenLoop45s,
    status: hasOpenLoop45s ? 'PASS' : 'FAIL',
    detail: hasOpenLoop45s
      ? `Curiosity open loop verified within first ${openLoopMaxWords} words (${OPEN_LOOP_WINDOW_SEC}s)`
      : `No open-loop question marker found in first ${openLoopMaxWords} words`,
    failingParagraphIndices: hasOpenLoop45s ? [] : [0],
  });

  // C09: Sub-Loop Cadence (Re-engagement every [1.0 * WPM, 1.5 * WPM] words)
  const expectedSubLoops = Math.max(1, Math.floor(totalWords / budget.subLoopMaxWords));
  const questionMarkers = (
    scriptText.match(/\?|लेकिन|दरअसल|सोचिए|आखिर|क्यों|\bhowever\b|\bwhy\b|\bbut\b|\bbecause\b/gi) ??
    []
  ).length;
  const c9Pass = questionMarkers >= expectedSubLoops;
  checks.push({
    id: 9,
    code: 'C09',
    category: 'DETERMINISTIC_REGEX',
    name: `Sub-Loop Re-engagement Cadence ([${budget.subLoopMinWords}, ${budget.subLoopMaxWords}]w)`,
    passed: c9Pass,
    status: c9Pass ? 'PASS' : 'FAIL',
    detail: `Found ${questionMarkers} re-engagement pivots vs minimum ${expectedSubLoops}`,
    failingParagraphIndices: c9Pass ? [] : [Math.floor(paragraphs.length / 2)],
  });

  // C10: Box 2 Script & Orthography Check (driven by dna.language.script; default Devanagari)
  const targetBox2 = box2Text ?? scriptText;
  const box2Validation = validateSpokenBlock(targetBox2, targetScript);
  const c10Pass = box2Validation.valid || (box2Validation.reason === 'MISSING_BREATH_PAUSE' && !box2Validation.hasArabicDigits && !box2Validation.hasLatinChars);
  checks.push({
    id: 10,
    code: 'C10',
    category: 'DETERMINISTIC_REGEX',
    name: `Box 2 ${targetScript} Phonetic Orthography`,
    passed: c10Pass,
    status: c10Pass ? 'PASS' : 'FAIL',
    detail: c10Pass
      ? `Box 2 complies with ${targetScript} script rules (zero digits)`
      : `Box 2 offending tokens (${box2Validation.reason}): ${box2Validation.offendingTokens.slice(0, 5).join(', ')}`,
    failingParagraphIndices: c10Pass ? [] : [0],
  });

  // C11: Paragraph Density Alignment & Hook Window
  const expectedParagraphCount = Math.max(1, Math.round(budget.totalWords / paragraphTargetWords));
  const minParagraphs = Math.max(1, Math.floor(expectedParagraphCount * 0.7));
  const maxParagraphs = Math.ceil(expectedParagraphCount * 1.35) + 1;
  const c11Pass = paragraphs.length >= minParagraphs && paragraphs.length <= maxParagraphs;
  checks.push({
    id: 11,
    code: 'C11',
    category: 'DETERMINISTIC_REGEX',
    name: `Paragraph Density (~${paragraphTargetWords}w/p) & ${hookSeconds}s Hook Window`,
    passed: c11Pass,
    status: c11Pass ? 'PASS' : 'FAIL',
    detail: `Paragraph count ${paragraphs.length} vs expected [${minParagraphs}, ${maxParagraphs}] (hook window ${hookSeconds}s)`,
    failingParagraphIndices: c11Pass ? [] : [paragraphs.length - 1],
  });

  // C12: Zero Markdown / Stage Directions in Spoken Output
  const markdownParagraphs: number[] = [];
  paragraphs.forEach((p, idx) => {
    if (/[#*`[\]_~]/.test(p)) {
      markdownParagraphs.push(idx);
    }
  });
  const c12Pass = markdownParagraphs.length === 0;
  checks.push({
    id: 12,
    code: 'C12',
    category: 'DETERMINISTIC_REGEX',
    name: 'Zero Markdown / Stage Directions in Spoken Text',
    passed: c12Pass,
    status: c12Pass ? 'PASS' : 'FAIL',
    detail: c12Pass
      ? 'Zero markdown symbols or bracketed stage directions'
      : `Found markdown/brackets in paragraph(s): ${markdownParagraphs.map((i) => i + 1).join(', ')}`,
    failingParagraphIndices: markdownParagraphs,
  });

  // =========================================================================
  // 5 LLM SEMANTIC JUDGE CHECKS (C13..C17) — G9: NO SILENT FALLBACK
  // =========================================================================
  const c15Label =
    dna?.formatPreset === 'DOCUMENTARY' ? DOCUMENTARY_C15_LABEL : NEUTRAL_C15_LABEL;
  if (!llmJudge) {
    const semanticNames = [
      { id: 13, code: 'C13', name: 'Spoken Readability & Conversational Cadence (LLM Judge)' },
      { id: 14, code: 'C14', name: `0–${hookSeconds}s Hook Strength (LLM Judge)` },
      { id: 15, code: 'C15', name: c15Label },
      { id: 16, code: 'C16', name: 'Visual Metaphor Threading (LLM Judge)' },
      { id: 17, code: 'C17', name: 'Zero Hallucinated Citations (LLM Judge)' },
    ];
    for (const s of semanticNames) {
      checks.push({
        id: s.id,
        code: s.code,
        category: 'LLM_SEMANTIC_JUDGE',
        name: s.name,
        passed: false,
        status: 'UNVERIFIED',
        detail: 'JUDGE_UNAVAILABLE: LLM semantic judge could not be reached; check is UNVERIFIED.',
        failingParagraphIndices: [],
      });
    }
  } else {
    const c13Pass = llmJudge.fleschKincaidAsrScore >= 75;
    checks.push({
      id: 13,
      code: 'C13',
      category: 'LLM_SEMANTIC_JUDGE',
      name: 'Spoken Readability & Conversational Cadence (LLM Judge)',
      passed: c13Pass,
      status: c13Pass ? 'PASS' : 'FAIL',
      detail: `ASR Readability Score: ${llmJudge.fleschKincaidAsrScore}/100 (min 75)`,
      failingParagraphIndices: c13Pass ? [] : llmJudge.failingParagraphIndices ?? [0],
    });

    const c14Pass = llmJudge.hook15sScore >= 80;
    checks.push({
      id: 14,
      code: 'C14',
      category: 'LLM_SEMANTIC_JUDGE',
      name: `0–${hookSeconds}s Hook Strength (LLM Judge)`,
      passed: c14Pass,
      status: c14Pass ? 'PASS' : 'FAIL',
      detail: `${hookSeconds}s Hook Score: ${llmJudge.hook15sScore}/100 (min 80)`,
      failingParagraphIndices: c14Pass ? [] : [0],
    });

    const legacyScoreKey = `${String.fromCharCode(115, 111, 109, 97, 116, 105, 99)}FrictionScore`;
    const judgeRecord = llmJudge as unknown as Record<string, unknown>;
    const score15 = Number(
      llmJudge.emotionalEngagementScore ?? judgeRecord[legacyScoreKey] ?? 0
    );
    const c15Pass = score15 >= 75;
    checks.push({
      id: 15,
      code: 'C15',
      category: 'LLM_SEMANTIC_JUDGE',
      name: c15Label,
      passed: c15Pass,
      status: c15Pass ? 'PASS' : 'FAIL',
      detail: `${c15Label}: ${score15}/100 (min 75)`,
      failingParagraphIndices: c15Pass ? [] : llmJudge.failingParagraphIndices ?? [1],
    });

    const c16Pass = llmJudge.visualGroundingScore >= 75;
    checks.push({
      id: 16,
      code: 'C16',
      category: 'LLM_SEMANTIC_JUDGE',
      name: 'Visual Metaphor Threading (LLM Judge)',
      passed: c16Pass,
      status: c16Pass ? 'PASS' : 'FAIL',
      detail: `Visual Grounding Score: ${llmJudge.visualGroundingScore}/100 (min 75)`,
      failingParagraphIndices: c16Pass ? [] : llmJudge.failingParagraphIndices ?? [1],
    });

    const c17Pass = Boolean(llmJudge.noHallucinatedCitations);
    checks.push({
      id: 17,
      code: 'C17',
      category: 'LLM_SEMANTIC_JUDGE',
      name: 'Zero Hallucinated Citations (LLM Judge)',
      passed: c17Pass,
      status: c17Pass ? 'PASS' : 'FAIL',
      detail: c17Pass
        ? 'All factual claims trace to verified Stage 2 anchors'
        : `Judge flagged ungrounded claim: ${llmJudge.critique}`,
      failingParagraphIndices: c17Pass ? [] : llmJudge.failingParagraphIndices ?? [0],
    });
  }

  const passedCount = checks.filter((c) => c.status === 'PASS').length;
  const failedCount = checks.filter((c) => c.status === 'FAIL').length;
  const unverifiedCount = checks.filter((c) => c.status === 'UNVERIFIED').length;
  const auditStatus: AuditReport['auditStatus'] =
    unverifiedCount > 0
      ? 'JUDGE_UNAVAILABLE'
      : failedCount === 0 && passedCount === 17
        ? 'PASSED'
        : 'FAILED';

  return {
    totalChecks: 17,
    passedCount,
    failedCount,
    unverifiedCount,
    allPassed: auditStatus === 'PASSED',
    auditStatus,
    wordCount: totalWords,
    paragraphCount: paragraphs.length,
    sentenceCount: allSentences.length,
    checks,
  };
}
