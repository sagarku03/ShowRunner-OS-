import { DEFAULT_WPM, TRANSCRIPT_FILE_MAX_BYTES } from '../../src/config/constants.ts';
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

export type TranscriptFileEncoding =
  | 'UTF-8'
  | 'UTF-8-BOM'
  | 'UTF-16LE'
  | 'UTF-16BE'
  | 'WINDOWS-1252';

export interface DecodedTranscriptFile {
  text: string;
  encoding: TranscriptFileEncoding;
  byteLength: number;
}

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
  lastWordEndInferred?: boolean;
  worstCaseCueErrorMs?: number;
  confirmEstimated?: boolean;
  fileName?: string;
  fileSizeBytes?: number;
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

export type TranscriptErrorCode =
  | 'TRANSCRIPT_TOO_SHORT'
  | 'TRANSCRIPT_INVALID'
  | 'TRANSCRIPT_GAP_WARNING'
  | 'TRANSCRIPT_UNITS_AMBIGUOUS'
  | 'TRANSCRIPT_REQUIRED'
  | 'TRANSCRIPT_FILE_TOO_LARGE'
  | 'TRANSCRIPT_FILE_EMPTY'
  | 'TRANSCRIPT_FILE_NOT_TEXT'
  | 'ESTIMATED_TIMINGS_UNCONFIRMED';

export function createTranscriptTypedError(
  code: TranscriptErrorCode,
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

/**
 * Pure byte decoder for uploaded transcript files (U1).
 * Handles UTF-8 (with/without BOM), UTF-16 LE/BE (via BOM), fallback windows-1252 only if UTF-8
 * produces replacement characters; Devanagari-safe; rejects > 5MB, empty files, and binary NUL bytes.
 */
export function decodeTranscriptBytes(
  input: ArrayBuffer | Uint8Array,
  maxBytes: number = TRANSCRIPT_FILE_MAX_BYTES
): DecodedTranscriptFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const byteLength = bytes.byteLength;

  if (byteLength === 0) {
    throw createTranscriptTypedError('TRANSCRIPT_FILE_EMPTY', 'Uploaded transcript file is empty (0 bytes).');
  }

  if (byteLength > maxBytes) {
    throw createTranscriptTypedError(
      'TRANSCRIPT_FILE_TOO_LARGE',
      `Transcript file size (${(byteLength / (1024 * 1024)).toFixed(2)} MB) exceeds maximum allowed ${(maxBytes / (1024 * 1024)).toFixed(1)} MB.`
    );
  }

  // 1. Check UTF-16 LE / BE BOM first (UTF-16 legitimately contains 0x00 bytes for ASCII characters)
  if (byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const payload = bytes.subarray(2);
    // Reject consecutive aligned double-zero code units (0x00 0x00) which indicate binary NUL char
    for (let i = 0; i + 1 < payload.length; i += 2) {
      if (payload[i] === 0x00 && payload[i + 1] === 0x00) {
        throw createTranscriptTypedError(
          'TRANSCRIPT_FILE_NOT_TEXT',
          'File contains binary NUL code units and is not a valid text transcript.'
        );
      }
    }
    const text = new TextDecoder('utf-16le').decode(payload);
    if (!text.trim()) {
      throw createTranscriptTypedError('TRANSCRIPT_FILE_EMPTY', 'Transcript file contains only whitespace.');
    }
    return { text, encoding: 'UTF-16LE', byteLength };
  }

  if (byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const payload = bytes.subarray(2);
    for (let i = 0; i + 1 < payload.length; i += 2) {
      if (payload[i] === 0x00 && payload[i + 1] === 0x00) {
        throw createTranscriptTypedError(
          'TRANSCRIPT_FILE_NOT_TEXT',
          'File contains binary NUL code units and is not a valid text transcript.'
        );
      }
    }
    const text = new TextDecoder('utf-16be').decode(payload);
    if (!text.trim()) {
      throw createTranscriptTypedError('TRANSCRIPT_FILE_EMPTY', 'Transcript file contains only whitespace.');
    }
    return { text, encoding: 'UTF-16BE', byteLength };
  }

  // 2. For non-UTF-16 files, any NUL byte (0x00) indicates binary/garbage file
  for (let i = 0; i < byteLength; i++) {
    if (bytes[i] === 0x00) {
      throw createTranscriptTypedError(
        'TRANSCRIPT_FILE_NOT_TEXT',
        'File contains binary NUL bytes and cannot be read as a text transcript.'
      );
    }
  }

  // 3. UTF-8 with or without BOM
  const hasUtf8Bom = byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = hasUtf8Bom ? bytes.subarray(3) : bytes;
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(payload);

  let finalText = utf8Text;
  let encoding: TranscriptFileEncoding = 'UTF-8';

  // Fallback to windows-1252 ONLY if UTF-8 decoding produced replacement characters (\uFFFD)
  if (utf8Text.includes('\uFFFD')) {
    finalText = new TextDecoder('windows-1252').decode(payload);
    encoding = 'WINDOWS-1252';
  }

  if (!finalText.trim()) {
    throw createTranscriptTypedError('TRANSCRIPT_FILE_EMPTY', 'Transcript file contains only whitespace.');
  }

  return {
    text: finalText,
    encoding,
    byteLength,
  };
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

// Preserve inline timestamp tags like <00:00:01.230> for YouTube WebVTT parsing while stripping other tags
const NON_SPEECH_REGEX = /<(?!\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>)[^>]+>|\[(?:music|applause|laughter|silence|snort|cough|ambient|sound|screaming|cheering)\]|\((?:laughs|music|sighs|clears throat|applause)\)|[♪♫]/gi;

export function stripAndCollectNonSpeechTokens(raw: string): {
  cleanedText: string;
  tokens: CleanedNonSpeechToken[];
} {
  const counts: Record<string, number> = {};
  const cleanedText = raw.replace(NON_SPEECH_REGEX, (match) => {
    // Do not count WebVTT <c> / </c> formatting tags as non-speech tokens
    if (/^<\/?c(?:\.[^>]*)?>$/i.test(match.trim())) {
      return '';
    }
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
 * Globally detects whether a sequence of numeric start/end pairs is in SECONDS or MILLISECONDS (P1.1).
 * Never flips per-word at 7200; applies one consistent unit factor across the entire file.
 */
export function detectGlobalNumericUnit(
  pairs: ReadonlyArray<{
    start: number;
    end: number;
    hasExplicitMsKey?: boolean;
    hasExplicitSecKey?: boolean;
  }>,
  unitsOverride?: DetectedTimeUnit
): 'SECONDS' | 'MILLISECONDS' {
  if (unitsOverride === 'MILLISECONDS') return 'MILLISECONDS';
  if (unitsOverride === 'SECONDS') return 'SECONDS';

  if (pairs.length === 0) return 'SECONDS';

  if (pairs.some((p) => p.hasExplicitMsKey)) return 'MILLISECONDS';
  if (pairs.some((p) => p.hasExplicitSecKey)) return 'SECONDS';

  const durations = pairs
    .map((p) => p.end - p.start)
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);

  const medianDur = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0;
  const maxEnd = Math.max(...pairs.map((p) => (Number.isFinite(p.end) ? p.end : 0)));
  const hasFractional = pairs.some((p) => !Number.isInteger(p.start) || !Number.isInteger(p.end));

  if (hasFractional && medianDur <= 15) {
    return 'SECONDS';
  }

  // Ambiguous zone: median word duration between 8 and 35 (too long for seconds, too short for ms)
  if (!hasFractional && medianDur > 8 && medianDur < 35 && maxEnd <= 7200) {
    throw createTranscriptTypedError(
      'TRANSCRIPT_UNITS_AMBIGUOUS',
      `Numeric timestamps are ambiguous (median word duration ${medianDur}). Select SECONDS or MILLISECONDS explicitly.`
    );
  }

  if (medianDur >= 35 || (maxEnd > 7200 && medianDur >= 15)) {
    return 'MILLISECONDS';
  }

  return 'SECONDS';
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

export interface ElevenLabsCharacterAlignmentBlock {
  characters?: unknown[];
  character_start_times_seconds?: unknown[];
  character_end_times_seconds?: unknown[];
  character_start_times_ms?: unknown[];
  character_end_times_ms?: unknown[];
  start_times?: unknown[];
  end_times?: unknown[];
}

/**
 * Resolves the alignment block from either top-level ElevenLabs/Cartesia JSON or nested
 * `{ alignment: {...}, normalized_alignment: {...} }` (preferring `alignment`, falling back to `normalized_alignment`).
 */
export function extractElevenLabsAlignmentBlock(
  rec: Record<string, unknown>
): ElevenLabsCharacterAlignmentBlock | null {
  const isAlignmentBlock = (candidate: unknown): candidate is ElevenLabsCharacterAlignmentBlock => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const b = candidate as Record<string, unknown>;
    return (
      Array.isArray(b.characters) &&
      b.characters.length > 0 &&
      (Array.isArray(b.character_start_times_seconds) ||
        Array.isArray(b.character_start_times_ms) ||
        Array.isArray(b.start_times))
    );
  };

  if (isAlignmentBlock(rec.alignment)) {
    return rec.alignment;
  }
  if (isAlignmentBlock(rec.normalized_alignment)) {
    return rec.normalized_alignment;
  }
  if (isAlignmentBlock(rec)) {
    return rec as ElevenLabsCharacterAlignmentBlock;
  }
  return null;
}

/**
 * Parses ElevenLabs / Cartesia character-level JSON alignment (P1.2).
 * Supports top-level and nested `{ alignment, normalized_alignment }`, `_seconds` and `_ms` variants,
 * honours `unitsOverride`, and is Devanagari-safe (combining marks stay attached to their word).
 */
export function parseCharacterAlignmentJson(
  obj: ElevenLabsCharacterAlignmentBlock | Record<string, unknown>,
  unitsOverride?: DetectedTimeUnit
): { words: TranscriptWordTimestamp[]; units: DetectedTimeUnit } {
  const block = extractElevenLabsAlignmentBlock(obj as Record<string, unknown>) ?? (obj as ElevenLabsCharacterAlignmentBlock);
  const chars = (block.characters || []).map((c) => String(c ?? ''));
  const hasExplicitMs = Array.isArray(block.character_start_times_ms);
  const hasExplicitSec = Array.isArray(block.character_start_times_seconds);
  const rawStarts = (
    hasExplicitMs
      ? block.character_start_times_ms
      : hasExplicitSec
        ? block.character_start_times_seconds
        : block.start_times
  ) || [];
  const rawEnds = (
    hasExplicitMs
      ? block.character_end_times_ms
      : hasExplicitSec
        ? block.character_end_times_seconds
        : block.end_times
  ) || [];

  if (chars.length === 0 || rawStarts.length === 0) {
    throw createTranscriptTypedError(
      'TRANSCRIPT_INVALID',
      'Character alignment arrays cannot be empty'
    );
  }

  const numericPairs: Array<{ start: number; end: number; hasExplicitMsKey: boolean; hasExplicitSecKey: boolean }> = [];
  for (let i = 0; i < chars.length; i++) {
    const sVal = Number(rawStarts[i] ?? NaN);
    const eVal = Number(rawEnds[i] ?? NaN);
    if (!Number.isFinite(sVal) || !Number.isFinite(eVal)) {
      throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Invalid non-finite character timecode', i);
    }
    numericPairs.push({
      start: sVal,
      end: eVal,
      hasExplicitMsKey: hasExplicitMs,
      hasExplicitSecKey: hasExplicitSec && !unitsOverride,
    });
  }

  const resolvedUnit = detectGlobalNumericUnit(numericPairs, unitsOverride);
  const isMs = resolvedUnit === 'MILLISECONDS';

  const words: TranscriptWordTimestamp[] = [];
  let currentChars: string[] = [];
  let wordStartMs: number | null = null;
  let wordEndMs: number = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const { start: sVal, end: eVal } = numericPairs[i];
    const cStartMs = isMs ? Math.round(sVal) : Math.round(sVal * 1000);
    const cEndMs = isMs ? Math.round(eVal) : Math.round(eVal * 1000);

    if (/^\s+$/u.test(char)) {
      if (currentChars.length > 0 && wordStartMs !== null) {
        const text = currentChars.join('').trim();
        if (text) {
          const finalEndMs = Math.max(wordStartMs + 20, wordEndMs);
          words.push({
            word: text,
            startMs: wordStartMs,
            endMs: finalEndMs,
            startSec: Number((wordStartMs / 1000).toFixed(3)),
            endSec: Number((finalEndMs / 1000).toFixed(3)),
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
      wordEndMs = Math.max(wordEndMs, cEndMs);
      currentChars.push(char);
    }
  }

  if (currentChars.length > 0 && wordStartMs !== null) {
    const text = currentChars.join('').trim();
    if (text) {
      const finalEndMs = Math.max(wordStartMs + 20, wordEndMs);
      words.push({
        word: text,
        startMs: wordStartMs,
        endMs: finalEndMs,
        startSec: Number((wordStartMs / 1000).toFixed(3)),
        endSec: Number((finalEndMs / 1000).toFixed(3)),
        estimated: false,
      });
    }
  }

  return { words, units: resolvedUnit };
}

function isTimecodeString(val: string | number): boolean {
  if (typeof val === 'number') return false;
  const str = String(val).trim();
  if (/^\d{2,}-\d{2}\.\d{1,3}$/.test(str.replace(/^#\[?/, '').replace(/\]$/, ''))) return true;
  if (/^\d+(?::\d{1,2}){1,2}(?:[.,]\d+)?$/.test(str)) return true;
  return false;
}

function parseTimecodeOnlyToMs(val: string | number): number {
  const str = String(val).trim();
  if (/^\d{2,}-\d{2}\.\d{1,3}$/.test(str.replace(/^#\[?/, '').replace(/\]$/, ''))) {
    return parseTimestampToMs(str);
  }
  if (/^\d+(?::\d{1,2}){1,2}(?:[.,]\d+)?$/.test(str)) {
    return Math.round(parseTimestampToSeconds(str) * 1000);
  }
  return NaN;
}

/**
 * Parses CSV or TSV transcripts with global unit detection.
 * Columns can be: `word,start,end` or `start,end,word`.
 */
export function parseDelimitedTranscript(
  raw: string,
  delimiter: string = ',',
  unitsOverride?: DetectedTimeUnit
): { words: TranscriptWordTimestamp[]; units: DetectedTimeUnit } {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Delimited transcript is empty');
  }

  let hasHeader = false;
  let wordCol = 0;
  let startCol = 1;
  let endCol = 2;
  let explicitHeaderMs = false;
  let explicitHeaderSec = false;

  const firstParts = lines[0].split(delimiter).map((p) => p.trim().replace(/^["']|["']$/g, ''));
  if (firstParts.some((p) => /^(word|text|start|end|start_time|end_time|startms|endms|startsec|endsec)/i.test(p))) {
    hasHeader = true;
    firstParts.forEach((col, idx) => {
      const lower = col.toLowerCase();
      if (lower === 'word' || lower === 'text') wordCol = idx;
      if (lower === 'start' || lower === 'start_time' || lower === 'startsec' || lower === 'startms') {
        startCol = idx;
        if (lower === 'startms') explicitHeaderMs = true;
        if (lower === 'startsec') explicitHeaderSec = true;
      }
      if (lower === 'end' || lower === 'end_time' || lower === 'endsec' || lower === 'endms') {
        endCol = idx;
        if (lower === 'endms') explicitHeaderMs = true;
        if (lower === 'endsec') explicitHeaderSec = true;
      }
    });
  } else {
    if (
      (!Number.isNaN(Number(firstParts[0])) || isTimecodeString(firstParts[0])) &&
      (!Number.isNaN(Number(firstParts[1])) || isTimecodeString(firstParts[1]))
    ) {
      startCol = 0;
      endCol = 1;
      wordCol = 2;
    }
  }

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rawEntries: Array<{ word: string; start: string; end: string }> = [];

  for (let i = 0; i < dataLines.length; i++) {
    const parts = dataLines[i].split(delimiter).map((p) => p.trim().replace(/^["']|["']$/g, ''));
    if (parts.length < 3) continue;
    rawEntries.push({
      word: parts[wordCol],
      start: parts[startCol],
      end: parts[endCol],
    });
  }

  if (rawEntries.length === 0) {
    throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'No valid rows in delimited transcript');
  }

  const allTimecodes = rawEntries.every((e) => isTimecodeString(e.start) && isTimecodeString(e.end));
  if (allTimecodes && (!unitsOverride || unitsOverride === 'TIMECODE')) {
    const words = rawEntries.map((e, idx) => {
      const sMs = parseTimecodeOnlyToMs(e.start);
      const eMs = parseTimecodeOnlyToMs(e.end);
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
    return { words, units: 'TIMECODE' };
  }

  const numericPairs = rawEntries.map((e, idx) => {
    const s = Number(e.start);
    const eVal = Number(e.end);
    if (!Number.isFinite(s) || !Number.isFinite(eVal)) {
      const tcStart = parseTimecodeOnlyToMs(e.start);
      const tcEnd = parseTimecodeOnlyToMs(e.end);
      if (Number.isFinite(tcStart) && Number.isFinite(tcEnd)) {
        return { start: tcStart, end: tcEnd, hasExplicitMsKey: true, hasExplicitSecKey: false };
      }
      throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Invalid numeric timestamp in CSV/TSV', idx);
    }
    return {
      start: s,
      end: eVal,
      hasExplicitMsKey: explicitHeaderMs && !unitsOverride,
      hasExplicitSecKey: explicitHeaderSec && !unitsOverride,
    };
  });

  const resolvedUnit = detectGlobalNumericUnit(numericPairs, unitsOverride);
  const isMs = resolvedUnit === 'MILLISECONDS';

  const words = rawEntries.map((e, idx) => {
    const pair = numericPairs[idx];
    const sMs = isMs ? Math.round(pair.start) : Math.round(pair.start * 1000);
    const eMs = isMs ? Math.round(pair.end) : Math.round(pair.end * 1000);
    return {
      word: e.word,
      startMs: sMs,
      endMs: eMs,
      startSec: Number((sMs / 1000).toFixed(3)),
      endSec: Number((eMs / 1000).toFixed(3)),
    };
  });

  return { words, units: resolvedUnit };
}

/**
 * Parses tagged lines like (P1.3):
 * `#[00-00.000] Word`
 * `#[00-00.450] Another`
 * End = next word start; last word end = start + median word duration and flagged `lastWordEndInferred: true`
 * (NEVER `estimated: true` so it grades as WORD_EXACT_MS / WORD_COARSE instead of CUE_INTERPOLATED).
 */
export function parseTaggedLinesTranscript(raw: string): {
  words: TranscriptWordTimestamp[];
  medianDurMs: number;
  lastWordEndInferred: boolean;
} {
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
    const endMs = next ? next.startMs : 0;
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
    const isLastItem = !next;

    const subWords = splitWords(cur.word);
    if (subWords.length <= 1) {
      words.push({
        word: cur.word,
        startMs: cur.startMs,
        endMs,
        startSec: Number((cur.startMs / 1000).toFixed(3)),
        endSec: Number((endMs / 1000).toFixed(3)),
        estimated: false,
        ...(isLastItem ? { lastWordEndInferred: true } : {}),
      });
    } else {
      const step = (endMs - cur.startMs) / subWords.length;
      subWords.forEach((sw, sIdx) => {
        const isVeryLastWord = isLastItem && sIdx === subWords.length - 1;
        const swStart = Math.round(cur.startMs + sIdx * step);
        const swEnd = Math.round(sIdx === subWords.length - 1 ? endMs : cur.startMs + (sIdx + 1) * step);
        words.push({
          word: sw,
          startMs: swStart,
          endMs: swEnd,
          startSec: Number((swStart / 1000).toFixed(3)),
          endSec: Number((swEnd / 1000).toFixed(3)),
          estimated: false,
          ...(isVeryLastWord ? { lastWordEndInferred: true } : {}),
        });
      });
    }
  }

  return { words, medianDurMs, lastWordEndInferred: true };
}

/**
 * Parses WebVTT or SRT cues, supporting:
 * - P1.5 YouTube / auto-caption inline word timestamps (`<00:00:01.230><c> word</c>`)
 * - P1.4 Word-per-cue VTT/SRT (>= 90% single-word cues -> word-level, no interpolation)
 * - Sentence-level cues -> proportional character-weighted interpolation (`CUE_INTERPOLATED`)
 */
export function parseSubtitleCues(
  cleanedText: string
): {
  words: TranscriptWordTimestamp[];
  isCueInterpolated: boolean;
  worstCaseCueErrorMs?: number;
} {
  const lines = cleanedText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rawCues: Array<{ startMs: number; endMs: number; text: string }> = [];

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
        const cueText = textLines.join(' ').trim();
        if (cueText) {
          rawCues.push({ startMs: cueStartMs, endMs: cueEndMs, text: cueText });
        }
      }
    }
  }

  if (rawCues.length === 0) {
    throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'No valid subtitle cues found.');
  }

  // Check P1.5: YouTube / auto-caption inline word timestamps (<00:00:01.230>)
  const inlineTagRegex = /<(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})>/;
  const hasInlineTimestamps = rawCues.some((c) => inlineTagRegex.test(c.text));

  if (hasInlineTimestamps) {
    const acc: TranscriptWordTimestamp[] = [];
    for (const cue of rawCues) {
      const parts = cue.text.split(/<(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})>/);
      // parts alternates: [textBeforeFirstTag, tag1, textAfterTag1, tag2, textAfterTag2, ...]
      const segments: Array<{ startMs: number; text: string }> = [];
      const leadingText = parts[0]?.replace(/<[^>]+>/g, ' ').trim();
      if (leadingText) {
        segments.push({ startMs: cue.startMs, text: leadingText });
      }
      for (let p = 1; p < parts.length; p += 2) {
        const tagStr = parts[p];
        const segText = (parts[p + 1] ?? '').replace(/<[^>]+>/g, ' ').trim();
        if (segText) {
          segments.push({ startMs: parseTimestampToMs(tagStr), text: segText });
        }
      }

      for (let sIdx = 0; sIdx < segments.length; sIdx++) {
        const seg = segments[sIdx];
        const nextSeg = segments[sIdx + 1];
        const segEndMs = nextSeg ? Math.max(seg.startMs + 20, nextSeg.startMs) : Math.max(seg.startMs + 20, cue.endMs);
        const tokens = splitWords(seg.text);
        if (tokens.length === 1) {
          acc.push({
            word: tokens[0],
            startMs: seg.startMs,
            endMs: segEndMs,
            startSec: Number((seg.startMs / 1000).toFixed(3)),
            endSec: Number((segEndMs / 1000).toFixed(3)),
            estimated: false,
          });
        } else if (tokens.length > 1) {
          const step = (segEndMs - seg.startMs) / tokens.length;
          tokens.forEach((tok, tIdx) => {
            const wStart = Math.round(seg.startMs + tIdx * step);
            const wEnd = Math.max(wStart + 20, Math.round(tIdx === tokens.length - 1 ? segEndMs : seg.startMs + (tIdx + 1) * step));
            acc.push({
              word: tok,
              startMs: wStart,
              endMs: wEnd,
              startSec: Number((wStart / 1000).toFixed(3)),
              endSec: Number((wEnd / 1000).toFixed(3)),
              estimated: false,
            });
          });
        }
      }
    }

    // Deduplicate rolling YouTube caption repeats where a cue repeats the previous cue's line
    const deduped: TranscriptWordTimestamp[] = [];
    for (const w of acc) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.word === w.word && Math.abs((w.startMs ?? 0) - (prev.startMs ?? 0)) <= 10) {
        continue;
      }
      deduped.push(w);
    }

    return {
      words: deduped,
      isCueInterpolated: false,
    };
  }

  // Check P1.4: Word-per-cue VTT/SRT (>= 90% of cues have a single word token)
  const cueTokenLists = rawCues.map((c) => ({
    ...c,
    tokens: splitWords(c.text.replace(/<[^>]+>/g, ' ').trim()),
  })).filter((c) => c.tokens.length > 0);

  const singleWordCueCount = cueTokenLists.filter((c) => c.tokens.length === 1).length;
  const singleWordRatio = cueTokenLists.length > 0 ? singleWordCueCount / cueTokenLists.length : 0;

  if (singleWordRatio >= 0.9) {
    const acc: TranscriptWordTimestamp[] = [];
    for (const cue of cueTokenLists) {
      if (cue.tokens.length === 1) {
        const wStartMs = cue.startMs;
        const wEndMs = Math.max(wStartMs + 20, cue.endMs);
        acc.push({
          word: cue.tokens[0],
          startMs: wStartMs,
          endMs: wEndMs,
          startSec: Number((wStartMs / 1000).toFixed(3)),
          endSec: Number((wEndMs / 1000).toFixed(3)),
          estimated: false,
        });
      } else {
        // Minor multi-word cue in an otherwise word-per-cue file
        const interpolated = interpolateCueWordsProportional(cue.tokens.join(' '), cue.startMs, cue.endMs);
        acc.push(...interpolated.map((w) => ({ ...w, estimated: false })));
      }
    }
    return {
      words: acc,
      isCueInterpolated: false,
    };
  }

  // Sentence-level cues -> CUE_INTERPOLATED
  const acc: TranscriptWordTimestamp[] = [];
  const cueDurationsMs: number[] = [];
  for (const cue of cueTokenLists) {
    cueDurationsMs.push(Math.max(50, cue.endMs - cue.startMs));
    acc.push(...interpolateCueWordsProportional(cue.text, cue.startMs, cue.endMs));
  }

  const sortedCueDurs = [...cueDurationsMs].sort((a, b) => a - b);
  const medianCueDurMs = sortedCueDurs[Math.floor(sortedCueDurs.length / 2)] || 1200;
  const worstCaseCueErrorMs = Math.max(100, Math.round(medianCueDurMs / 2));

  return {
    words: acc,
    isCueInterpolated: true,
    worstCaseCueErrorMs,
  };
}

/**
 * Parses plain timed lines like:
 * `0.00 0.50 Hello` or `Hello 0.00 0.50`
 */
export function parsePlainTimedLines(
  raw: string,
  unitsOverride?: DetectedTimeUnit
): { words: TranscriptWordTimestamp[]; units: DetectedTimeUnit; isCueInterpolated: boolean } {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rawWordPairs: Array<{ word: string; startRaw: string; endRaw: string }> = [];
  const singleTimedLines: Array<{ startMs: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const singleMatch = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\s+(.+)$/);
    if (singleMatch) {
      const tokens = line.split(/\s+/).filter(Boolean);
      const secondTokenClean = tokens.length >= 3 ? tokens[1].replace(/^\[|\]$/g, '') : '';
      const secondIsValid =
        secondTokenClean.length > 0 &&
        (isTimecodeString(secondTokenClean) || Number.isFinite(Number(secondTokenClean)));
      if (!secondIsValid) {
        const sMs = parseTimecodeOnlyToMs(singleMatch[1]);
        if (Number.isFinite(sMs)) {
          singleTimedLines.push({ startMs: sMs, text: singleMatch[2].trim() });
          continue;
        }
      }
    }

    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 3) continue;

    const t0 = tokens[0].replace(/^\[|\]$/g, '');
    const t1 = tokens[1].replace(/^\[|\]$/g, '');
    const t0Valid = isTimecodeString(t0) || Number.isFinite(Number(t0));
    const t1Valid = isTimecodeString(t1) || Number.isFinite(Number(t1));
    if (t0Valid && t1Valid) {
      rawWordPairs.push({
        word: tokens.slice(2).join(' '),
        startRaw: t0,
        endRaw: t1,
      });
      continue;
    }

    const tLast2 = tokens[tokens.length - 2].replace(/^\[|\]$/g, '');
    const tLast1 = tokens[tokens.length - 1].replace(/^\[|\]$/g, '');
    const tLast2Valid = isTimecodeString(tLast2) || Number.isFinite(Number(tLast2));
    const tLast1Valid = isTimecodeString(tLast1) || Number.isFinite(Number(tLast1));
    if (tLast2Valid && tLast1Valid) {
      rawWordPairs.push({
        word: tokens.slice(0, tokens.length - 2).join(' '),
        startRaw: tLast2,
        endRaw: tLast1,
      });
    }
  }

  if (rawWordPairs.length > 0) {
    const allTimecodes = rawWordPairs.every((p) => isTimecodeString(p.startRaw) && isTimecodeString(p.endRaw));
    if (allTimecodes && (!unitsOverride || unitsOverride === 'TIMECODE')) {
      const words = rawWordPairs.map((p) => {
        const sMs = parseTimecodeOnlyToMs(p.startRaw);
        const eMs = Math.max(sMs + 20, parseTimecodeOnlyToMs(p.endRaw));
        return {
          word: p.word,
          startMs: sMs,
          endMs: eMs,
          startSec: Number((sMs / 1000).toFixed(3)),
          endSec: Number((eMs / 1000).toFixed(3)),
        };
      });
      return { words, units: 'TIMECODE', isCueInterpolated: false };
    }

    const numericPairs = rawWordPairs.map((p) => ({
      start: isTimecodeString(p.startRaw) ? parseTimecodeOnlyToMs(p.startRaw) : Number(p.startRaw),
      end: isTimecodeString(p.endRaw) ? parseTimecodeOnlyToMs(p.endRaw) : Number(p.endRaw),
    }));
    const resolvedUnit = detectGlobalNumericUnit(numericPairs, unitsOverride);
    const isMs = resolvedUnit === 'MILLISECONDS';
    const words = rawWordPairs.map((p, idx) => {
      const pair = numericPairs[idx];
      const sMs = isMs ? Math.round(pair.start) : Math.round(pair.start * 1000);
      const eMs = Math.max(sMs + 20, isMs ? Math.round(pair.end) : Math.round(pair.end * 1000));
      return {
        word: p.word,
        startMs: sMs,
        endMs: eMs,
        startSec: Number((sMs / 1000).toFixed(3)),
        endSec: Number((eMs / 1000).toFixed(3)),
      };
    });
    return { words, units: resolvedUnit, isCueInterpolated: false };
  }

  if (singleTimedLines.length > 0) {
    const words: TranscriptWordTimestamp[] = [];
    for (let i = 0; i < singleTimedLines.length; i++) {
      const cur = singleTimedLines[i];
      const next = singleTimedLines[i + 1];
      const subWords = splitWords(cur.text);
      const endMs = next ? Math.max(cur.startMs + subWords.length * 50, next.startMs) : cur.startMs + Math.max(1, subWords.length) * 400;
      words.push(...interpolateCueWordsProportional(cur.text, cur.startMs, endMs));
    }
    return { words, units: 'TIMECODE', isCueInterpolated: true };
  }

  throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Unable to parse plain timed lines');
}

/**
 * Computes precision grade per PRD P2.3:
 * - WORD_EXACT_MS: word-level times, >= 85% carry non-zero millisecond digits
 * - WORD_COARSE: word-level but rounded (0.1s / 1s / 10ms)
 * - CUE_INTERPOLATED: cue/sentence level, interpolated
 */
export function computePrecisionGrade(
  words: ReadonlyArray<TranscriptWordTimestamp>,
  isCueInterpolated: boolean
): { precisionGrade: PrecisionGrade; warning?: string } {
  const estimatedCount = words.filter((w) => w.estimated === true).length;
  if (isCueInterpolated || (words.length > 0 && estimatedCount / words.length > 0.1)) {
    return {
      precisionGrade: 'CUE_INTERPOLATED',
      warning: 'CUE_INTERPOLATED: Timestamps are interpolated from sentence-level cues. Words are marked as ESTIMATED.',
    };
  }

  let true3DigitMsCount = 0;
  for (const w of words) {
    const sMs = typeof w.startMs === 'number' ? w.startMs : Math.round(w.startSec * 1000);
    const eMs = typeof w.endMs === 'number' ? w.endMs : Math.round(w.endSec * 1000);
    if (sMs % 100 !== 0 || eMs % 100 !== 0) {
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
      if (sMs < prevEndMs - 50) {
        throw createTranscriptTypedError(
          'TRANSCRIPT_INVALID',
          `Non-monotonic timestamp: start (${sMs}ms) overlaps previous end (${prevEndMs}ms) by >50ms`,
          i
        );
      }

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
 * Helper to convert a flat array of JSON word records using global unit detection (P1.1).
 */
function parseJsonWordArray(
  items: ReadonlyArray<Record<string, unknown>>,
  unitsOverride?: DetectedTimeUnit
): { words: TranscriptWordTimestamp[]; units: DetectedTimeUnit } {
  const rawEntries = items.map((w, i) => {
    const text = String(w.word ?? w.text ?? w.token ?? '').trim();
    const hasExplicitMsKey = w.startMs !== undefined || w.endMs !== undefined || w.start_ms !== undefined || w.end_ms !== undefined;
    const hasExplicitSecKey = w.startSec !== undefined || w.endSec !== undefined || w.start_sec !== undefined || w.end_sec !== undefined;
    const rawS = w.start ?? w.startTime ?? w.startSec ?? w.start_sec ?? w.startMs ?? w.start_ms;
    const rawE = w.end ?? w.endTime ?? w.endSec ?? w.end_sec ?? w.endMs ?? w.end_ms;

    if (!text || rawS === undefined || rawE === undefined) {
      throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Invalid JSON word entry', i);
    }

    if (typeof rawS === 'string' && isTimecodeString(rawS) && typeof rawE === 'string' && isTimecodeString(rawE)) {
      return {
        text,
        isTimecode: true,
        start: parseTimecodeOnlyToMs(rawS),
        end: parseTimecodeOnlyToMs(rawE),
        hasExplicitMsKey: true,
        hasExplicitSecKey: false,
      };
    }

    const s = Number(rawS);
    const e = Number(rawE);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Non-finite JSON word timestamp', i);
    }

    return {
      text,
      isTimecode: false,
      start: s,
      end: e,
      hasExplicitMsKey: hasExplicitMsKey && !unitsOverride,
      hasExplicitSecKey: hasExplicitSecKey && !unitsOverride,
    };
  });

  if (rawEntries.every((e) => e.isTimecode) && (!unitsOverride || unitsOverride === 'TIMECODE')) {
    const words = rawEntries.map((e) => ({
      word: e.text,
      startMs: e.start,
      endMs: e.end,
      startSec: Number((e.start / 1000).toFixed(3)),
      endSec: Number((e.end / 1000).toFixed(3)),
      estimated: false,
    }));
    return { words, units: 'TIMECODE' };
  }

  const resolvedUnit = detectGlobalNumericUnit(rawEntries, unitsOverride);
  const isMs = resolvedUnit === 'MILLISECONDS';

  const words = rawEntries.map((e) => {
    const sMs = e.isTimecode || isMs ? Math.round(e.start) : Math.round(e.start * 1000);
    const eMs = e.isTimecode || isMs ? Math.round(e.end) : Math.round(e.end * 1000);
    return {
      word: e.text,
      startMs: sMs,
      endMs: eMs,
      startSec: Number((sMs / 1000).toFixed(3)),
      endSec: Number((eMs / 1000).toFixed(3)),
      estimated: false,
    };
  });

  return { words, units: resolvedUnit };
}

/**
 * Express Transcript master parse routine.
 * Handles WebVTT (including word-per-cue and YouTube inline timestamps), SRT, WhisperX,
 * Descript, ElevenLabs/Cartesia (top-level and nested), Flat JSON (seconds or integer ms),
 * CSV, TSV, Tagged Lines, and Plain Timed Lines.
 */
export function parseExpressTranscript(
  rawInput: string,
  scriptText?: string,
  options?: {
    allowShort?: boolean;
    unitsOverride?: DetectedTimeUnit;
    fileName?: string;
    fileSizeBytes?: number;
    confirmEstimated?: boolean;
  }
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
  let lastWordEndInferred = false;
  let worstCaseCueErrorMs: number | undefined;
  let extraWarnings: string[] = [];
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
      const res = parseJsonWordArray(obj as Array<Record<string, unknown>>, options?.unitsOverride);
      parsedWords = res.words;
      detectedUnits = res.units;
    } else if (obj && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      const elevenBlock = extractElevenLabsAlignmentBlock(rec);
      if (elevenBlock) {
        detectedFormat = 'ELEVENLABS_ALIGNMENT_JSON';
        const res = parseCharacterAlignmentJson(elevenBlock, options?.unitsOverride);
        parsedWords = res.words;
        detectedUnits = res.units;
      } else if (
        rec.word_timestamps &&
        typeof rec.word_timestamps === 'object' &&
        !Array.isArray(rec.word_timestamps) &&
        Array.isArray((rec.word_timestamps as Record<string, unknown>).words)
      ) {
        // Cartesia word_timestamps: { words: string[], start: number[], end: number[] }
        detectedFormat = 'ELEVENLABS_ALIGNMENT_JSON';
        const wt = rec.word_timestamps as { words: unknown[]; start?: unknown[]; end?: unknown[] };
        const items = wt.words.map((w, idx) => ({
          word: String(w ?? ''),
          start: wt.start?.[idx],
          end: wt.end?.[idx],
        }));
        const res = parseJsonWordArray(items, options?.unitsOverride);
        parsedWords = res.words;
        detectedUnits = res.units;
      } else if (Array.isArray(rec.segments)) {
        detectedFormat = 'WHISPERX_JSON';
        const segs = rec.segments as Array<{
          words?: Array<Record<string, unknown>>;
          text?: string;
          start?: number;
          end?: number;
        }>;
        const flatSegWords: Array<Record<string, unknown>> = [];
        const cueFallbackSegs: Array<{ text: string; start: number; end: number }> = [];

        for (const seg of segs) {
          if (Array.isArray(seg.words) && seg.words.length > 0) {
            for (const w of seg.words) {
              flatSegWords.push(w);
            }
          } else if (seg.text && Number.isFinite(Number(seg.start)) && Number.isFinite(Number(seg.end))) {
            cueFallbackSegs.push({
              text: seg.text,
              start: Number(seg.start),
              end: Number(seg.end),
            });
          }
        }

        if (flatSegWords.length > 0) {
          const res = parseJsonWordArray(flatSegWords, options?.unitsOverride);
          parsedWords = res.words;
          detectedUnits = res.units;
        } else if (cueFallbackSegs.length > 0) {
          isCueInterpolated = true;
          const unit = detectGlobalNumericUnit(cueFallbackSegs, options?.unitsOverride);
          detectedUnits = unit;
          const isMs = unit === 'MILLISECONDS';
          const acc: TranscriptWordTimestamp[] = [];
          const cueDurs: number[] = [];
          for (const seg of cueFallbackSegs) {
            const sMs = isMs ? Math.round(seg.start) : Math.round(seg.start * 1000);
            const eMs = isMs ? Math.round(seg.end) : Math.round(seg.end * 1000);
            cueDurs.push(Math.max(50, eMs - sMs));
            acc.push(...interpolateCueWordsProportional(seg.text, sMs, eMs));
          }
          const sortedDurs = [...cueDurs].sort((a, b) => a - b);
          worstCaseCueErrorMs = Math.max(100, Math.round((sortedDurs[Math.floor(sortedDurs.length / 2)] || 1200) / 2));
          parsedWords = acc;
        }
      } else if (Array.isArray(rec.words)) {
        detectedFormat = 'DESCRIPT_JSON';
        const res = parseJsonWordArray(rec.words as Array<Record<string, unknown>>, options?.unitsOverride);
        parsedWords = res.words;
        detectedUnits = res.units;
      } else {
        throw createTranscriptTypedError('TRANSCRIPT_INVALID', 'Unrecognized JSON transcript schema.');
      }
    }
  }
  // 2. Tagged lines: #[MM-SS.mmm]
  else if (/^#\[\d{2,}-\d{2}\.\d{3}\]/m.test(cleanedText)) {
    detectedFormat = 'TAGGED_LINES';
    detectedUnits = 'TIMECODE';
    const taggedRes = parseTaggedLinesTranscript(cleanedText);
    parsedWords = taggedRes.words;
    lastWordEndInferred = taggedRes.lastWordEndInferred;
    if (lastWordEndInferred) {
      extraWarnings.push(
        `Last word end time was inferred (lastWordEndInferred) from median word duration (+${taggedRes.medianDurMs}ms).`
      );
    }
  }
  // 3. WebVTT
  else if (cleanedText.startsWith('WEBVTT') || (cleanedText.includes('-->') && cleanedText.toLowerCase().includes('webvtt'))) {
    detectedFormat = 'WEBVTT';
    detectedUnits = 'TIMECODE';
    const subRes = parseSubtitleCues(cleanedText);
    parsedWords = subRes.words;
    isCueInterpolated = subRes.isCueInterpolated;
    worstCaseCueErrorMs = subRes.worstCaseCueErrorMs;
  }
  // 4. SRT
  else if (cleanedText.includes('-->')) {
    detectedFormat = 'SRT';
    detectedUnits = 'TIMECODE';
    const subRes = parseSubtitleCues(cleanedText);
    parsedWords = subRes.words;
    isCueInterpolated = subRes.isCueInterpolated;
    worstCaseCueErrorMs = subRes.worstCaseCueErrorMs;
  }
  // 5. CSV / TSV
  else if (cleanedText.includes('\t') && (cleanedText.includes('\n') || cleanedText.split('\t').length >= 3)) {
    detectedFormat = 'TSV';
    const res = parseDelimitedTranscript(cleanedText, '\t', options?.unitsOverride);
    parsedWords = res.words;
    detectedUnits = res.units;
  } else if (cleanedText.includes(',') && cleanedText.split('\n')[0].split(',').length >= 3) {
    detectedFormat = 'CSV';
    const res = parseDelimitedTranscript(cleanedText, ',', options?.unitsOverride);
    parsedWords = res.words;
    detectedUnits = res.units;
  }
  // 6. Plain timed lines
  else {
    detectedFormat = 'PLAIN_TIMED_LINES';
    const res = parsePlainTimedLines(cleanedText, options?.unitsOverride);
    parsedWords = res.words;
    detectedUnits = res.units;
    isCueInterpolated = res.isCueInterpolated;
  }

  // Re-detect language from extracted spoken words so timecodes/JSON keys do not skew Latin vs Devanagari
  const spokenOnlyText = parsedWords.map((w) => w.word).join(' ');
  const resolvedLanguage = spokenOnlyText.trim() ? detectLanguageAndScript(spokenOnlyText) : language;

  // Validate timestamps in original input order so offendingIndex is exact
  const { warnings, gaps } = validateWordTimestamps(parsedWords, options);
  for (const w of extraWarnings) {
    warnings.push(w);
  }

  const { precisionGrade, warning: gradeWarning } = computePrecisionGrade(parsedWords, isCueInterpolated);
  if (gradeWarning) {
    warnings.unshift(gradeWarning);
  }

  const metrology = computeTranscriptMetrology(parsedWords, gaps);

  if (precisionGrade === 'CUE_INTERPOLATED' && !worstCaseCueErrorMs) {
    worstCaseCueErrorMs = Math.max(150, Math.round(metrology.medianWordDurationMs * 2));
  }

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
    ...(lastWordEndInferred ? { lastWordEndInferred: true } : {}),
    ...(worstCaseCueErrorMs ? { worstCaseCueErrorMs } : {}),
    ...(options?.confirmEstimated !== undefined ? { confirmEstimated: options.confirmEstimated } : {}),
    ...(options?.fileName ? { fileName: options.fileName } : {}),
    ...(options?.fileSizeBytes !== undefined ? { fileSizeBytes: options.fileSizeBytes } : {}),
    detectedLanguage: resolvedLanguage,
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
