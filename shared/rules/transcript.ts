import { DEFAULT_WPM } from '../../src/config/constants.ts';
import { splitWords } from './math.ts';
import type { TranscriptWordTimestamp } from './slicer.ts';
import {
  formatTimestampTag,
  formatRangeLabel,
  parseTimestampToMs,
  parseTimestampToSeconds,
} from './timestamps.ts';

export type PrecisionGrade = 'WORD_EXACT_MS' | 'WORD_COARSE' | 'CUE_INTERPOLATED';

export type DetectedTranscriptFormat =
  | 'WEBVTT'
  | 'SRT'
  | 'WHISPERX_JSON'
  | 'DESCRIPT_JSON'
  | 'FLAT_JSON'
  | 'ELEVENLABS_ALIGNMENT_JSON'
  | 'CSV'
  | 'TSV'
  | 'TAGGED_LINES'
  | 'PLAIN_TIMED_LINES';

export type DetectedTimeUnit = 'SECONDS' | 'MILLISECONDS' | 'TIMECODE';

export interface CleanedNonSpeechToken {
  token: string;
  count: number;
}

export interface GapWarning {
  startIndex: number;
  endIndex: number;
  gapMs: number;
  startTag: string;
  endTag: string;
}

export interface ScriptParagraphAlignment {
  paragraphIndex: number;
  scriptParagraph: string;
  transcriptText: string;
  startWordIndex: number;
  endWordIndex: number;
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface ScriptAlignmentResult {
  aligned: boolean;
  confidence: number;
  paragraphs: ScriptParagraphAlignment[];
  notice?: string;
}

export interface TranscriptMetrology {
  wordCount: number;
  lockedRuntimeMs: number;
  lockedRuntimeSec: number;
  actualWpm: number;
  avgWordDurationMs: number;
  medianWordDurationMs: number;
  silenceCount: number;
  totalSilenceMs: number;
  longestSilenceMs: number;
  gaps: GapWarning[];
  estimatedScenes: {
    mode1ImageCount: number;
    mode2VideoCount: number;
  };
}

export interface ParsedTranscriptMeta {
  format: DetectedTranscriptFormat;
  units: DetectedTimeUnit;
  precisionGrade: PrecisionGrade;
  hasEstimatedWords: boolean;
  detectedLanguage: {
    primary: string;
    script: 'Devanagari' | 'Latin' | 'Other';
  };
  cleanedTokens: CleanedNonSpeechToken[];
  warnings: string[];
  gaps: GapWarning[];
  metrology: TranscriptMetrology;
  scriptAlignment?: ScriptAlignmentResult;
}

export interface FullParsedTranscriptResult {
  words: TranscriptWordTimestamp[];
  meta: ParsedTranscriptMeta;
  box1ReconstructedText: string;
}

export interface ChapterMarker {
  index: number;
  title: string;
  startSec: number;
  timestampTag: string;
}

export interface CitationCardMarker {
  index: number;
  sourceLabel: string;
  quoteOrClaim: string;
  startSec: number;
  timestampTag: string;
}

export interface ParsedTranscriptResult {
  format: string;
  timingQuality: 'WORD_LEVEL' | 'INTERPOLATED';
  words: Array<{ word: string; start: number; end: number }>;
  wordCount: number;
  lockedRuntimeSec: number;
  actualWpm: number;
  configuredWpm: number;
  driftPercent: number;
  masterChapterTimeline: ChapterMarker[];
  onScreenCitationCards: CitationCardMarker[];
}

export function createTranscriptTypedError(
  code:
    | 'TRANSCRIPT_TOO_SHORT'
    | 'TRANSCRIPT_INVALID'
    | 'TRANSCRIPT_GAP_WARNING'
    | 'TRANSCRIPT_UNITS_AMBIGUOUS'
    | 'TRANSCRIPT_REQUIRED',
  message: string,
  offendingIndex?: number,
  statusCode: number = 422
): Error & { code: string; statusCode: number; offendingIndex?: number } {
  const suffix = typeof offendingIndex === 'number' ? ` (at index ${offendingIndex})` : '';
  const err = new Error(`${code}: ${message}${suffix}`) as Error & {
    code: string;
    statusCode: number;
    offendingIndex?: number;
  };
  err.code = code;
  err.statusCode = statusCode;
  if (typeof offendingIndex === 'number') {
    err.offendingIndex = offendingIndex;
  }
  return err;
}

export function detectLanguageAndScript(text: string): {
  primary: string;
  script: 'Devanagari' | 'Latin' | 'Other';
} {
  const devanagariMatches = text.match(/[\u0900-\u097F]/g) || [];
  const latinMatches = text.match(/[A-Za-z]/g) || [];

  if (devanagariMatches.length > 10 || devanagariMatches.length > latinMatches.length * 0.4) {
    return { primary: 'Hindi', script: 'Devanagari' };
  }
  if (latinMatches.length > 0) {
    return { primary: 'English', script: 'Latin' };
  }
  return { primary: 'Universal', script: 'Other' };
}

const NON_SPEECH_REGEX = /<[^>]+>|\[(?:music|applause|laughter|silence|snort|cough|ambient|sound|screaming|cheering)\]|\((?:laughs|music|sighs|clears throat|applause)\)|[♪♫]/gi;

export function stripAndCollectNonSpeechTokens(raw: string): {
  cleanedText: string;
  tokens: CleanedNonSpeechToken[];
} {
  const counts: Record<string, number> = {};
  const cleanedText = raw.replace(NON_SPEECH_REGEX, (match) => {
    const key = match.trim().toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
    return ' ';
  });

  const tokens: CleanedNonSpeechToken[] = Object.entries(counts).map(([token, count]) => ({
    token,
    count,
  }));
  return { cleanedText, tokens };
}

/**
 * Proportional character-weighted interpolation for cue-level transcripts (WebVTT / SRT).
 * Never spreads evenly by word count; longer words receive proportionally longer durations.
 * Every returned word carries `estimated: true`.
 */
export function interpolateCueWordsProportional(
  cueText: string,
  startMs: number,
  endMs: number
): TranscriptWordTimestamp[] {
  const tokens = splitWords(cueText.replace(/<[^>]+>/g, ' ').trim());
  if (tokens.length === 0) return [];

  const durationMs = Math.max(50, endMs - startMs);
  const charWeights = tokens.map((t) => Math.max(1, t.length));
  const totalWeight = charWeights.reduce((acc, w) => acc + w, 0);

  let cursorMs = startMs;
  return tokens.map((token, idx) => {
    const isLast = idx === tokens.length - 1;
    const share = charWeights[idx] / totalWeight;
    const wordDurMs = isLast ? endMs - cursorMs : Math.round(durationMs * share);
    const wStartMs = cursorMs;
    const wEndMs = Math.max(wStartMs + 20, isLast ? endMs : cursorMs + wordDurMs);
    cursorMs = wEndMs;

    return {
      word: token,
      startSec: Number((wStartMs / 1000).toFixed(3)),
      endSec: Number((wEndMs / 1000).toFixed(3)),
      startMs: wStartMs,
      endMs: wEndMs,
      estimated: true,
    };
  });
}

/**
 * Parses ElevenLabs / Cartesia character-level JSON alignment.
 * Schema: { characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[] }
 */
export function parseCharacterAlignmentJson(obj: {
  characters?: unknown[];
  character_start_times_seconds?: unknown[];
  character_end_times_seconds?: unknown[];
  character_start_times_ms?: unknown[];
  character_end_times_ms?: unknown[];
}): TranscriptWordTimestamp[] {
  const chars = (obj.characters || []).map((c) => String(c ?? ''));
  const isMs = Array.isArray(obj.character_start_times_ms);
  const starts = (isMs ? obj.character_start_times_ms : obj.character_start_times_seconds) || [];
  const ends = (isMs ? obj.character_end_times_ms : obj.character_end_times_seconds) || [];

  if (chars.length === 0 || starts.length === 0) {
    throw createTranscriptTypedError(
      'TRANSCRIPT_INVALID',
      'Character alignment arrays cannot be empty'
    );
  }

  const words: TranscriptWordTimestamp[] = [];
  let currentChars: string[] = [];
  let wordStartMs: number | null = null;
  let wordEndMs: number = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const sVal = Number(starts[i] ?? NaN);
    const eVal = Number(ends[i] ?? NaN);
    if (!Number.isFinite(sVal) || !Number.isFinite(eVal)) {
      throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Invalid non-finite character timecode', i);
    }
    const cStartMs = isMs ? Math.round(sVal) : Math.round(sVal * 1000);
    const cEndMs = isMs ? Math.round(eVal) : Math.round(eVal * 1000);

    if (/\s/.test(char)) {
      if (currentChars.length > 0 && wordStartMs !== null) {
        const text = currentChars.join('').trim();
        if (text) {
          words.push({
            word: text,
            startMs: wordStartMs,
            endMs: Math.max(wordStartMs + 20, wordEndMs),
            startSec: Number((wordStartMs / 1000).toFixed(3)),
            endSec: Number((Math.max(wordStartMs + 20, wordEndMs) / 1000).toFixed(3)),
            estimated: false,
          });
        }
        currentChars = [];
        wordStartMs = null;
      }
    } else {
      if (wordStartMs === null) {
        wordStartMs = cStartMs;
      }
      wordEndMs = cEndMs;
      currentChars.push(char);
    }
  }

  if (currentChars.length > 0 && wordStartMs !== null) {
    const text = currentChars.join('').trim();
    if (text) {
      words.push({
        word: text,
        startMs: wordStartMs,
        endMs: Math.max(wordStartMs + 20, wordEndMs),
        startSec: Number((wordStartMs / 1000).toFixed(3)),
        endSec: Number((Math.max(wordStartMs + 20, wordEndMs) / 1000).toFixed(3)),
        estimated: false,
      });
    }
  }

  return words;
}

/**
 * Parses CSV or TSV transcripts.
 * Columns can be: `word,start,end` or `start,end,word`.
 */
export function parseDelimitedTranscript(raw: string, delimiter: string = ','): TranscriptWordTimestamp[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Delimited transcript is empty');
  }

  let hasHeader = false;
  let wordCol = 0;
  let startCol = 1;
  let endCol = 2;

  const firstParts = lines[0].split(delimiter).map((p) => p.trim().replace(/^["']|["']$/g, ''));
  if (firstParts.some((p) => /^(word|text|start|end|start_time|end_time)/i.test(p))) {
    hasHeader = true;
    firstParts.forEach((col, idx) => {
      const lower = col.toLowerCase();
      if (lower === 'word' || lower === 'text') wordCol = idx;
      if (lower === 'start' || lower === 'start_time' || lower === 'startsec' || lower === 'startms') startCol = idx;
      if (lower === 'end' || lower === 'end_time' || lower === 'endsec' || lower === 'endms') endCol = idx;
    });
  } else {
    // Detect column order by seeing which token is numeric
    if (!Number.isNaN(Number(firstParts[0])) && !Number.isNaN(Number(firstParts[1]))) {
      startCol = 0;
      endCol = 1;
      wordCol = 2;
    }
  }

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rawEntries: Array<{ word: string; start: string | number; end: string | number }> = [];

  for (let i = 0; i < dataLines.length; i++) {
    const parts = dataLines[i].split(delimiter).map((p) => p.trim().replace(/^["']|["']$/g, ''));
    if (parts.length < 3) continue;
    rawEntries.push({
      word: parts[wordCol],
      start: parts[startCol],
      end: parts[endCol],
    });
  }

  return rawEntries.map((e, idx) => {
    const sMs = parseTimecodeOrNumberToMs(e.start);
    const eMs = parseTimecodeOrNumberToMs(e.end);
    if (!Number.isFinite(sMs) || !Number.isFinite(eMs)) {
      throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Invalid timecode in CSV/TSV', idx);
    }
    return {
      word: e.word,
      startMs: sMs,
      endMs: eMs,
      startSec: Number((sMs / 1000).toFixed(3)),
      endSec: Number((eMs / 1000).toFixed(3)),
    };
  });
}

function parseTimecodeOrNumberToMs(val: string | number): number {
  if (typeof val === 'number') {
    return val > 7200 ? Math.round(val) : Math.round(val * 1000);
  }
  const str = String(val).trim();
  if (/^\d{2,}-\d{2}\.\d{1,3}$/.test(str.replace(/^#\[?/, '').replace(/\]$/, ''))) {
    return parseTimestampToMs(str);
  }
  if (/^\d+(?::\d{1,2}){1,2}(?:[.,]\d+)?$/.test(str)) {
    return Math.round(parseTimestampToSeconds(str) * 1000);
  }
  const n = Number(str);
  if (!Number.isFinite(n)) return NaN;
  return n > 7200 ? Math.round(n) : Math.round(n * 1000);
}

/**
 * Parses tagged lines like:
 * `#[00-00.000] Word`
 * `#[00-00.450] Another`
 */
export function parseTaggedLinesTranscript(raw: string): TranscriptWordTimestamp[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: Array<{ tag: string; startMs: number; word: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^#\[(\d{2,}-\d{2}\.\d{3})\]\s*(.*)$/);
    if (!match) continue;
    const tag = match[1];
    const rest = match[2].trim();
    if (!rest) continue;
    const startMs = parseTimestampToMs(tag);
    items.push({ tag, startMs, word: rest });
  }

  if (items.length === 0) {
    throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'No valid #[MM-SS.mmm] tagged lines found');
  }

  const words: TranscriptWordTimestamp[] = [];
  const durations: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    const next = items[i + 1];
    let endMs = next ? next.startMs : 0;
    if (endMs > cur.startMs) {
      durations.push(endMs - cur.startMs);
    }
  }

  const medianDurMs = durations.length > 0
    ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]
    : 350;

  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    const next = items[i + 1];
    const endMs = next ? next.startMs : cur.startMs + medianDurMs;
    const isEstimated = !next;

    // Line might have multiple words
    const subWords = splitWords(cur.word);
    if (subWords.length <= 1) {
      words.push({
        word: cur.word,
        startMs: cur.startMs,
        endMs,
        startSec: Number((cur.startMs / 1000).toFixed(3)),
        endSec: Number((endMs / 1000).toFixed(3)),
        estimated: isEstimated,
      });
    } else {
      const step = (endMs - cur.startMs) / subWords.length;
      subWords.forEach((sw, sIdx) => {
        const swStart = Math.round(cur.startMs + sIdx * step);
        const swEnd = Math.round(sIdx === subWords.length - 1 ? endMs : cur.startMs + (sIdx + 1) * step);
        words.push({
          word: sw,
          startMs: swStart,
          endMs: swEnd,
          startSec: Number((swStart / 1000).toFixed(3)),
          endSec: Number((swEnd / 1000).toFixed(3)),
          estimated: isEstimated,
        });
      });
    }
  }

  return words;
}

/**
 * Parses plain timed lines like:
 * `0.00 0.50 Hello` or `Hello 0.00 0.50`
 */
export function parsePlainTimedLines(raw: string): TranscriptWordTimestamp[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const words: TranscriptWordTimestamp[] = [];
  const singleTimedLines: Array<{ startMs: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check single bracketed or unbracketed timecode at start of line: e.g. "[00:00.000] Plain timed line"
    const singleMatch = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\s+(.+)$/);
    if (singleMatch) {
      const tokens = line.split(/\s+/).filter(Boolean);
      const secondTokenMs = tokens.length >= 3 ? parseTimecodeOrNumberToMs(tokens[1].replace(/^\[|\]$/g, '')) : NaN;
      if (!Number.isFinite(secondTokenMs)) {
        const sMs = parseTimecodeOrNumberToMs(singleMatch[1]);
        if (Number.isFinite(sMs)) {
          singleTimedLines.push({ startMs: sMs, text: singleMatch[2].trim() });
          continue;
        }
      }
    }

    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 3) continue;

    // Pattern A: start end word...
    const sA = parseTimecodeOrNumberToMs(tokens[0].replace(/^\[|\]$/g, ''));
    const eA = parseTimecodeOrNumberToMs(tokens[1].replace(/^\[|\]$/g, ''));
    if (Number.isFinite(sA) && Number.isFinite(eA) && eA >= sA) {
      const word = tokens.slice(2).join(' ');
      words.push({
        word,
        startMs: sA,
        endMs: Math.max(sA + 20, eA),
        startSec: Number((sA / 1000).toFixed(3)),
        endSec: Number((Math.max(sA + 20, eA) / 1000).toFixed(3)),
      });
      continue;
    }

    // Pattern B: word... start end
    const sB = parseTimecodeOrNumberToMs(tokens[tokens.length - 2].replace(/^\[|\]$/g, ''));
    const eB = parseTimecodeOrNumberToMs(tokens[tokens.length - 1].replace(/^\[|\]$/g, ''));
    if (Number.isFinite(sB) && Number.isFinite(eB) && eB >= sB) {
      const word = tokens.slice(0, tokens.length - 2).join(' ');
      words.push({
        word,
        startMs: sB,
        endMs: Math.max(sB + 20, eB),
        startSec: Number((sB / 1000).toFixed(3)),
        endSec: Number((Math.max(sB + 20, eB) / 1000).toFixed(3)),
      });
    }
  }

  if (words.length === 0 && singleTimedLines.length > 0) {
    for (let i = 0; i < singleTimedLines.length; i++) {
      const cur = singleTimedLines[i];
      const next = singleTimedLines[i + 1];
      const subWords = splitWords(cur.text);
      const endMs = next ? Math.max(cur.startMs + subWords.length * 50, next.startMs) : cur.startMs + Math.max(1, subWords.length) * 400;
      words.push(...interpolateCueWordsProportional(cur.text, cur.startMs, endMs));
    }
  }

  if (words.length === 0) {
    throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Unable to parse plain timed lines');
  }

  return words;
}

/**
 * Computes precision grade per PRD P2.3:
 * - WORD_EXACT_MS: word-level times, >= 90% carry non-zero millisecond digits
 * - WORD_COARSE: word-level but rounded (0.1s / 1s / 10ms)
 * - CUE_INTERPOLATED: cue/sentence level, interpolated
 */
export function computePrecisionGrade(
  words: ReadonlyArray<TranscriptWordTimestamp>,
  isCueInterpolated: boolean
): { precisionGrade: PrecisionGrade; warning?: string } {
  if (isCueInterpolated || words.some((w) => w.estimated === true)) {
    return {
      precisionGrade: 'CUE_INTERPOLATED',
      warning: 'CUE_INTERPOLATED: Timestamps are interpolated from sentence-level cues. Words are marked as ESTIMATED.',
    };
  }

  let true3DigitMsCount = 0;
  for (const w of words) {
    const ms = typeof w.startMs === 'number' ? w.startMs : Math.round(w.startSec * 1000);
    // Non-zero millisecond digits: not a clean multiple of 100ms or 1000ms
    if (ms % 100 !== 0) {
      true3DigitMsCount += 1;
    }
  }

  const ratio = words.length > 0 ? true3DigitMsCount / words.length : 0;
  if (ratio >= 0.85) {
    return { precisionGrade: 'WORD_EXACT_MS' };
  }

  return {
    precisionGrade: 'WORD_COARSE',
    warning: 'WORD_COARSE: Timestamps appear rounded to tenths or seconds. Scene cuts may vary by up to 100ms.',
  };
}

/**
 * Validates word timestamps per PRD P2.4:
 * Detects NaN, negative, start >= end, non-monotonic, and overlaps > 50ms.
 */
export function validateWordTimestamps(
  words: ReadonlyArray<TranscriptWordTimestamp>,
  options?: { allowShort?: boolean }
): { warnings: string[]; gaps: GapWarning[] } {
  if (!words || words.length === 0) {
    throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Word list is empty');
  }

  const warnings: string[] = [];
  const gaps: GapWarning[] = [];
  let prevEndMs = 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const sMs = typeof w.startMs === 'number' ? w.startMs : Math.round(w.startSec * 1000);
    const eMs = typeof w.endMs === 'number' ? w.endMs : Math.round(w.endSec * 1000);

    if (!Number.isFinite(sMs) || !Number.isFinite(eMs)) {
      throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Non-finite timestamp value', i);
    }
    if (sMs < 0 || eMs < 0) {
      throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Negative timestamp value', i);
    }
    if (eMs <= sMs) {
      throw createTranscriptTypedError(
        'TRANSCRIPT_INVALID',
        `End timestamp (${eMs}ms) <= start (${sMs}ms)`,
        i
      );
    }

    if (i > 0) {
      // Overlap > 50ms is invalid
      if (sMs < prevEndMs - 50) {
        throw createTranscriptTypedError(
          'TRANSCRIPT_INVALID',
          `Non-monotonic timestamp: start (${sMs}ms) overlaps previous end (${prevEndMs}ms) by >50ms`,
          i
        );
      }

      // Silence gap > 2000ms
      const gapMs = sMs - prevEndMs;
      if (gapMs > 2000) {
        gaps.push({
          startIndex: i - 1,
          endIndex: i,
          gapMs,
          startTag: formatTimestampTag(prevEndMs, true),
          endTag: formatTimestampTag(sMs, true),
        });
      }
    }

    prevEndMs = eMs;
  }

  if (!options?.allowShort) {
    const totalRuntimeSec = (words[words.length - 1].endMs ?? Math.round(words[words.length - 1].endSec * 1000)) / 1000;
    if (words.length < 50 || totalRuntimeSec < 20) {
      throw createTranscriptTypedError(
        'TRANSCRIPT_TOO_SHORT',
        `Transcript too short (${words.length} words, ${totalRuntimeSec.toFixed(1)}s; minimum 50 words and 20s required for Express Mode)`
      );
    }
  }

  if (gaps.length > 0) {
    warnings.push(
      `Detected ${gaps.length} silence gap(s) > 2.0s (longest: ${(Math.max(...gaps.map((g) => g.gapMs)) / 1000).toFixed(1)}s).`
    );
  }

  return { warnings, gaps };
}

/**
 * Computes runtime metrology per PRD P2.5.
 * lockedRuntimeMs = last word endMs (never start).
 */
export function computeTranscriptMetrology(
  words: ReadonlyArray<TranscriptWordTimestamp>,
  gaps: GapWarning[]
): TranscriptMetrology {
  if (words.length === 0) {
    return {
      wordCount: 0,
      lockedRuntimeMs: 0,
      lockedRuntimeSec: 0,
      actualWpm: 0,
      avgWordDurationMs: 0,
      medianWordDurationMs: 0,
      silenceCount: 0,
      totalSilenceMs: 0,
      longestSilenceMs: 0,
      gaps: [],
      estimatedScenes: { mode1ImageCount: 0, mode2VideoCount: 0 },
    };
  }

  const lastWord = words[words.length - 1];
  const lockedRuntimeMs = typeof lastWord.endMs === 'number' ? lastWord.endMs : Math.round(lastWord.endSec * 1000);
  const lockedRuntimeSec = Number((lockedRuntimeMs / 1000).toFixed(3));
  const wordCount = words.length;

  const actualWpm = lockedRuntimeMs > 0
    ? Number(((wordCount / (lockedRuntimeMs / 60000))).toFixed(2))
    : 0;

  const durations = words.map((w) => {
    const s = typeof w.startMs === 'number' ? w.startMs : Math.round(w.startSec * 1000);
    const e = typeof w.endMs === 'number' ? w.endMs : Math.round(w.endSec * 1000);
    return Math.max(1, e - s);
  });

  const totalDur = durations.reduce((a, b) => a + b, 0);
  const avgWordDurationMs = Math.round(totalDur / durations.length);
  const sortedDurs = [...durations].sort((a, b) => a - b);
  const medianWordDurationMs = sortedDurs[Math.floor(sortedDurs.length / 2)] || avgWordDurationMs;

  const totalSilenceMs = gaps.reduce((acc, g) => acc + g.gapMs, 0);
  const longestSilenceMs = gaps.length > 0 ? Math.max(...gaps.map((g) => g.gapMs)) : 0;

  const mode1ImageCount = Math.max(1, Math.round(lockedRuntimeSec / 2.0));
  const mode2VideoCount = Math.max(1, Math.round(lockedRuntimeSec / 6.0));

  return {
    wordCount,
    lockedRuntimeMs,
    lockedRuntimeSec,
    actualWpm,
    avgWordDurationMs,
    medianWordDurationMs,
    silenceCount: gaps.length,
    totalSilenceMs,
    longestSilenceMs,
    gaps,
    estimatedScenes: {
      mode1ImageCount,
      mode2VideoCount,
    },
  };
}

/**
 * Deterministic fuzzy script-paragraph alignment per PRD P2.6.
 * Aligns transcript words to script paragraphs by n-gram token overlap (code only, no LLM).
 */
export function alignScriptParagraphs(
  scriptText: string,
  words: ReadonlyArray<TranscriptWordTimestamp>
): ScriptAlignmentResult {
  const hasDoubleNewline = /\r?\n\s*\r?\n/.test(scriptText);
  const rawParagraphs = (hasDoubleNewline ? scriptText.split(/\r?\n\s*\r?\n/) : scriptText.split(/\r?\n/))
    .map((p) => p.trim())
    .filter(Boolean);

  if (rawParagraphs.length === 0 || words.length === 0) {
    return { aligned: false, confidence: 0, paragraphs: [] };
  }

  const normalizeToken = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const transcriptTokens = words.map((w) => normalizeToken(w.word)).filter(Boolean);

  let wordCursor = 0;
  let totalMatched = 0;
  let totalScriptWords = 0;
  const alignments: ScriptParagraphAlignment[] = [];

  for (let pIdx = 0; pIdx < rawParagraphs.length; pIdx++) {
    const pText = rawParagraphs[pIdx];
    const pTokens = splitWords(pText).map(normalizeToken).filter(Boolean);
    totalScriptWords += pTokens.length;

    if (pTokens.length === 0) continue;

    // Slide window in transcript to find best matching block
    const pLen = pTokens.length;
    const windowStart = wordCursor;
    const windowEnd = Math.min(words.length, wordCursor + Math.max(pLen * 2, 12));

    let bestScore = 0;
    let bestStart = windowStart;
    let bestEnd = Math.min(words.length - 1, windowStart + pLen - 1);

    for (let testStart = windowStart; testStart < windowEnd && testStart < words.length; testStart++) {
      const testEnd = Math.min(words.length - 1, testStart + pLen - 1);
      const windowSlice = transcriptTokens.slice(testStart, testEnd + 1);
      let matchCount = 0;
      for (const tok of pTokens) {
        if (windowSlice.includes(tok)) {
          matchCount += 1;
        }
      }
      if (matchCount > bestScore) {
        bestScore = matchCount;
        bestStart = testStart;
        bestEnd = testEnd;
      }
    }

    const conf = pLen > 0 ? Number((bestScore / pLen).toFixed(2)) : 0;
    totalMatched += bestScore;
    wordCursor = Math.min(words.length - 1, bestEnd + 1);

    const startWord = words[bestStart] || words[0];
    const endWord = words[bestEnd] || words[words.length - 1];

    alignments.push({
      paragraphIndex: pIdx + 1,
      scriptParagraph: pText,
      transcriptText: words.slice(bestStart, bestEnd + 1).map((w) => w.word).join(' '),
      startWordIndex: bestStart,
      endWordIndex: bestEnd,
      startMs: startWord.startMs ?? Math.round(startWord.startSec * 1000),
      endMs: endWord.endMs ?? Math.round(endWord.endSec * 1000),
      confidence: conf,
    });
  }

  const overallConfidence = totalScriptWords > 0
    ? Number((totalMatched / totalScriptWords).toFixed(2))
    : 0;

  if (overallConfidence < 0.35) {
    return {
      aligned: false,
      confidence: overallConfidence,
      paragraphs: [],
      notice: `Script alignment confidence was low (${Math.round(overallConfidence * 100)}%). Script text differed significantly from spoken audio and was ignored.`,
    };
  }

  return {
    aligned: true,
    confidence: overallConfidence,
    paragraphs: alignments,
  };
}

/**
 * Express Transcript master parse routine.
 * Handles WebVTT, SRT, WhisperX, Descript, ElevenLabs/Cartesia, CSV, TSV, Tagged Lines, and Plain Timed Lines.
 */
export function parseExpressTranscript(
  rawInput: string,
  scriptText?: string,
  options?: { allowShort?: boolean; unitsOverride?: DetectedTimeUnit }
): FullParsedTranscriptResult {
  const trimmed = rawInput.trim().replace(/^\uFEFF/, '');
  if (!trimmed) {
    throw createTranscriptTypedError('TRANSCRIPT_REQUIRED', 'Transcript content is empty.');
  }

  const { cleanedText, tokens: cleanedTokens } = stripAndCollectNonSpeechTokens(trimmed);
  const language = detectLanguageAndScript(cleanedText);

  let detectedFormat: DetectedTranscriptFormat = 'PLAIN_TIMED_LINES';
  let detectedUnits: DetectedTimeUnit = options?.unitsOverride ?? 'SECONDS';
  let isCueInterpolated = false;
  let parsedWords: TranscriptWordTimestamp[] = [];

  // 1. JSON (exclude plain timed lines starting with [MM:SS.mmm])
  if (
    cleanedText.startsWith('{') ||
    (cleanedText.startsWith('[') && !/^\[\d{1,2}[:\-]\d{2}/.test(cleanedText))
  ) {
    let obj: unknown;
    try {
      obj = JSON.parse(cleanedText);
    } catch (err) {
      throw createTranscriptTypedError('TRANSCRIPT_INVALID', `Malformed JSON transcript: ${(err as Error).message}`);
    }

    if (Array.isArray(obj)) {
      detectedFormat = 'FLAT_JSON';
      parsedWords = (obj as Array<Record<string, unknown>>).map((w, i) => {
        const text = String(w.word ?? w.text ?? '').trim();
        const s = Number(w.start ?? w.startTime ?? w.startSec ?? w.startMs ?? NaN);
        const e = Number(w.end ?? w.endTime ?? w.endSec ?? w.endMs ?? NaN);
        if (!text || !Number.isFinite(s) || !Number.isFinite(e)) {
          throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Invalid flat JSON entry', i);
        }
        const sMs = parseTimecodeOrNumberToMs(s);
        const eMs = parseTimecodeOrNumberToMs(e);
        return {
          word: text,
          startMs: sMs,
          endMs: eMs,
          startSec: Number((sMs / 1000).toFixed(3)),
          endSec: Number((eMs / 1000).toFixed(3)),
        };
      });
    } else if (obj && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      // ElevenLabs / Cartesia character-level JSON
      if (Array.isArray(rec.characters) && (Array.isArray(rec.character_start_times_seconds) || Array.isArray(rec.character_start_times_ms))) {
        detectedFormat = 'ELEVENLABS_ALIGNMENT_JSON';
        detectedUnits = Array.isArray(rec.character_start_times_ms) ? 'MILLISECONDS' : 'SECONDS';
        parsedWords = parseCharacterAlignmentJson(rec as Parameters<typeof parseCharacterAlignmentJson>[0]);
      } else if (Array.isArray(rec.segments)) {
        detectedFormat = 'WHISPERX_JSON';
        const segs = rec.segments as Array<{ words?: Array<{ word?: string; text?: string; start?: number; end?: number }>; text?: string; start?: number; end?: number }>;
        const acc: TranscriptWordTimestamp[] = [];
        for (const seg of segs) {
          if (Array.isArray(seg.words) && seg.words.length > 0) {
            for (const w of seg.words) {
              const text = String(w.word ?? w.text ?? '').trim();
              const s = Number(w.start ?? NaN);
              const e = Number(w.end ?? NaN);
              if (text && Number.isFinite(s) && Number.isFinite(e)) {
                const sMs = Math.round(s * 1000);
                const eMs = Math.round(e * 1000);
                acc.push({
                  word: text,
                  startMs: sMs,
                  endMs: eMs,
                  startSec: Number((sMs / 1000).toFixed(3)),
                  endSec: Number((eMs / 1000).toFixed(3)),
                });
              }
            }
          } else if (seg.text && Number.isFinite(Number(seg.start)) && Number.isFinite(Number(seg.end))) {
            isCueInterpolated = true;
            acc.push(...interpolateCueWordsProportional(seg.text, Math.round(Number(seg.start) * 1000), Math.round(Number(seg.end) * 1000)));
          }
        }
        parsedWords = acc;
      } else if (Array.isArray(rec.words)) {
        detectedFormat = 'DESCRIPT_JSON';
        parsedWords = (rec.words as Array<Record<string, unknown>>).map((w, i) => {
          const text = String(w.word ?? w.text ?? '').trim();
          const s = Number(w.start ?? w.startTime ?? w.startSec ?? NaN);
          const e = Number(w.end ?? w.endTime ?? w.endSec ?? NaN);
          if (!text || !Number.isFinite(s) || !Number.isFinite(e)) {
            throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Invalid word entry in JSON', i);
          }
          const sMs = Math.round(s * 1000);
          const eMs = Math.round(e * 1000);
          return {
            word: text,
            startMs: sMs,
            endMs: eMs,
            startSec: Number((sMs / 1000).toFixed(3)),
            endSec: Number((eMs / 1000).toFixed(3)),
          };
        });
      }
    }
  }
  // 2. Tagged lines: #[MM-SS.mmm]
  else if (/^#\[\d{2,}-\d{2}\.\d{3}\]/m.test(cleanedText)) {
    detectedFormat = 'TAGGED_LINES';
    detectedUnits = 'TIMECODE';
    parsedWords = parseTaggedLinesTranscript(cleanedText);
  }
  // 3. WebVTT
  else if (cleanedText.startsWith('WEBVTT') || (cleanedText.includes('-->') && cleanedText.toLowerCase().includes('webvtt'))) {
    detectedFormat = 'WEBVTT';
    detectedUnits = 'TIMECODE';
    isCueInterpolated = true;
    const lines = cleanedText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const acc: TranscriptWordTimestamp[] = [];
    let cueStartMs = 0;
    let cueEndMs = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('-->')) {
        const match = line.match(/^\s*(\S+)\s*-->\s*(\S+)/);
        if (match) {
          cueStartMs = parseTimestampToMs(match[1]);
          cueEndMs = parseTimestampToMs(match[2]);
          i++;
          const textLines: string[] = [];
          while (i < lines.length && !lines[i].includes('-->') && !/^\d+$/.test(lines[i])) {
            textLines.push(lines[i]);
            i++;
          }
          i--;
          const cueText = textLines.join(' ');
          acc.push(...interpolateCueWordsProportional(cueText, cueStartMs, cueEndMs));
        }
      }
    }
    parsedWords = acc;
  }
  // 4. SRT
  else if (cleanedText.includes('-->')) {
    detectedFormat = 'SRT';
    detectedUnits = 'TIMECODE';
    isCueInterpolated = true;
    const lines = cleanedText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const acc: TranscriptWordTimestamp[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('-->')) {
        const match = line.match(/^\s*(\S+)\s*-->\s*(\S+)/);
        if (match) {
          const cueStartMs = parseTimestampToMs(match[1]);
          const cueEndMs = parseTimestampToMs(match[2]);
          i++;
          const textLines: string[] = [];
          while (i < lines.length && !lines[i].includes('-->') && !/^\d+$/.test(lines[i])) {
            textLines.push(lines[i]);
            i++;
          }
          i--;
          acc.push(...interpolateCueWordsProportional(textLines.join(' '), cueStartMs, cueEndMs));
        }
      }
    }
    parsedWords = acc;
  }
  // 5. CSV / TSV
  else if (cleanedText.includes('\t') && (cleanedText.includes('\n') || cleanedText.split('\t').length >= 3)) {
    detectedFormat = 'TSV';
    parsedWords = parseDelimitedTranscript(cleanedText, '\t');
  } else if (cleanedText.includes(',') && cleanedText.split('\n')[0].split(',').length >= 3) {
    detectedFormat = 'CSV';
    parsedWords = parseDelimitedTranscript(cleanedText, ',');
  }
  // 6. Plain timed lines
  else {
    detectedFormat = 'PLAIN_TIMED_LINES';
    parsedWords = parsePlainTimedLines(cleanedText);
  }

  // Validate timestamps in original input order so offendingIndex is exact
  const { warnings, gaps } = validateWordTimestamps(parsedWords, options);
  const { precisionGrade, warning: gradeWarning } = computePrecisionGrade(parsedWords, isCueInterpolated);
  if (gradeWarning) {
    warnings.unshift(gradeWarning);
  }

  const metrology = computeTranscriptMetrology(parsedWords, gaps);

  // Script alignment
  let scriptAlignment: ScriptAlignmentResult | undefined;
  let box1ReconstructedText = '';

  if (scriptText && scriptText.trim()) {
    scriptAlignment = alignScriptParagraphs(scriptText, parsedWords);
    if (scriptAlignment.aligned) {
      box1ReconstructedText = scriptAlignment.paragraphs
        .map((p) => p.scriptParagraph)
        .join('\n\n');
    }
  }

  if (!box1ReconstructedText) {
    // Reconstruct paragraphs from transcript words
    const chunks: string[] = [];
    const wordsPerPara = 130;
    for (let i = 0; i < parsedWords.length; i += wordsPerPara) {
      chunks.push(
        parsedWords
          .slice(i, i + wordsPerPara)
          .map((w) => w.word)
          .join(' ')
      );
    }
    box1ReconstructedText = chunks.join('\n\n');
  }

  const meta: ParsedTranscriptMeta = {
    format: detectedFormat,
    units: detectedUnits,
    precisionGrade,
    hasEstimatedWords: isCueInterpolated || parsedWords.some((w) => w.estimated === true),
    detectedLanguage: language,
    cleanedTokens,
    warnings,
    gaps,
    metrology,
    scriptAlignment,
  };

  return {
    words: parsedWords,
    meta,
    box1ReconstructedText,
  };
}

/**
 * Legacy adapter for Stage 5 timeline markers and existing callers.
 */
export function buildTimelineMarkers(
  words: ReadonlyArray<{ word: string; start: number; end: number }>,
  chapterTitles?: ReadonlyArray<string>,
  citations?: ReadonlyArray<{ sourceLabel: string; quoteOrClaim: string }>
): {
  masterChapterTimeline: ChapterMarker[];
  onScreenCitationCards: CitationCardMarker[];
} {
  if (words.length === 0) {
    return { masterChapterTimeline: [], onScreenCitationCards: [] };
  }

  const defaultChapters =
    chapterTitles && chapterTitles.length > 0
      ? chapterTitles
      : [
          'The Hidden Anomaly',
          'Why Conventional Explanations Fail',
          'Inside the Core Mechanism',
          'The Critical Turning Point',
          'Real-World Consequence & Resolution',
        ];

  const masterChapterTimeline: ChapterMarker[] = defaultChapters.map((title, idx) => {
    const wordIdx = Math.min(
      words.length - 1,
      Math.floor((idx / defaultChapters.length) * words.length)
    );
    const startSec = idx === 0 ? 0 : words[wordIdx].start;
    return {
      index: idx + 1,
      title,
      startSec: Number(startSec.toFixed(3)),
      timestampTag: formatTimestampTag(startSec),
    };
  });

  const defaultCitations =
    citations && citations.length > 0
      ? citations
      : [
          {
            sourceLabel: 'Primary Empirical Finding',
            quoteOrClaim: words
              .slice(0, Math.min(12, words.length))
              .map((w) => w.word)
              .join(' '),
          },
          {
            sourceLabel: 'Mechanistic Evidence',
            quoteOrClaim: words
              .slice(
                Math.floor(words.length * 0.4),
                Math.min(words.length, Math.floor(words.length * 0.4) + 12)
              )
              .map((w) => w.word)
              .join(' '),
          },
        ];

  const onScreenCitationCards: CitationCardMarker[] = defaultCitations.map((c, idx) => {
    const ratio = (idx + 1) / (defaultCitations.length + 1);
    const wordIdx = Math.min(words.length - 1, Math.floor(ratio * words.length));
    const startSec = words[wordIdx].start;
    return {
      index: idx + 1,
      sourceLabel: c.sourceLabel,
      quoteOrClaim: c.quoteOrClaim,
      startSec: Number(startSec.toFixed(3)),
      timestampTag: formatTimestampTag(startSec),
    };
  });

  return { masterChapterTimeline, onScreenCitationCards };
}

export function parseTranscriptContent(
  rawContent: string,
  configuredWpm: number = DEFAULT_WPM,
  options?: {
    chapterTitles?: ReadonlyArray<string>;
    citations?: ReadonlyArray<{ sourceLabel: string; quoteOrClaim: string }>;
  }
): ParsedTranscriptResult {
  const result = parseExpressTranscript(rawContent, undefined, { allowShort: true });
  const sorted = result.words.map((w) => ({
    word: w.word,
    start: w.startSec,
    end: w.endSec,
  }));

  const wordCount = sorted.length;
  const lockedRuntimeSec = result.meta.metrology.lockedRuntimeSec;
  const actualWpm = result.meta.metrology.actualWpm;
  const safeConfigWpm = configuredWpm > 0 ? configuredWpm : DEFAULT_WPM;
  const driftPercent = Number((((actualWpm - safeConfigWpm) / safeConfigWpm) * 100).toFixed(2));

  const { masterChapterTimeline, onScreenCitationCards } = buildTimelineMarkers(
    sorted,
    options?.chapterTitles,
    options?.citations
  );

  return {
    format: result.meta.format,
    timingQuality: result.meta.precisionGrade === 'CUE_INTERPOLATED' ? 'INTERPOLATED' : 'WORD_LEVEL',
    words: sorted,
    wordCount,
    lockedRuntimeSec,
    actualWpm,
    configuredWpm: safeConfigWpm,
    driftPercent,
    masterChapterTimeline,
    onScreenCitationCards,
  };
}
