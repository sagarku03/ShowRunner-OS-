import {
  resolveModelLockedPacing,
  type GenerationMode,
  type VideoProvider,
} from '../../src/config/constants.ts';
import { splitWords } from './math.ts';
import { formatTimestampTag, formatRangeLabel } from './timestamps.ts';

export interface TranscriptWordTimestamp {
  word: string;
  startSec: number;
  endSec: number;
  startMs?: number;
  endMs?: number;
  estimated?: boolean;
}

export interface StoryboardSlot {
  slotIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  actionSec: number;
  holdSec: number;
  startMs?: number;
  endMs?: number;
  durationMs?: number;
  actionMs?: number;
  holdMs?: number;
  spokenSegment: string;
  wordCount: number;
  timestampTag?: string;
  rangeLabel?: string;
}

export interface SlicerConfig {
  words: ReadonlyArray<TranscriptWordTimestamp>;
  mode: GenerationMode;
  provider?: VideoProvider;
  defaultClipDuration?: number;
  preferredCutRangeSec?: readonly [number, number] | null;
}

function createTranscriptInvalidError(
  message: string,
  offendingIndex?: number
): Error & { code: string; statusCode: number; offendingIndex?: number } {
  const suffix =
    typeof offendingIndex === 'number' ? ` (offending index ${offendingIndex})` : '';
  const err = new Error(`TRANSCRIPT_INVALID: ${message}${suffix}`) as Error & {
    code: string;
    statusCode: number;
    offendingIndex?: number;
  };
  err.code = 'TRANSCRIPT_INVALID';
  err.statusCode = 422;
  if (typeof offendingIndex === 'number') {
    err.offendingIndex = offendingIndex;
  }
  return err;
}

function parseTimecodeToSec(tc: string): number {
  const cleaned = tc.trim().replace(',', '.');
  if (!/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(cleaned)) {
    return Number.NaN;
  }
  const parts = cleaned.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return Number.NaN;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return Number.NaN;
}

function stripSubtitleMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]+\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface RawJsonWordEntry {
  word?: unknown;
  text?: unknown;
  token?: unknown;
  start?: unknown;
  end?: unknown;
  startSec?: unknown;
  endSec?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  startMs?: unknown;
  endMs?: unknown;
}

function validateAndNormaliseWordEntries(
  rawEntries: ReadonlyArray<RawJsonWordEntry>,
  forceMs: boolean = false
): TranscriptWordTimestamp[] {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw createTranscriptInvalidError('Transcript word list is empty.');
  }

  // Detect millisecond integer scale if not explicitly flagged
  let isMsScale = forceMs;
  if (!isMsScale) {
    const usesExplicitMsKeys = rawEntries.some(
      (e) => e && (e.startMs !== undefined || e.endMs !== undefined)
    );
    if (usesExplicitMsKeys) {
      isMsScale = true;
    } else {
      const sampleNumeric: Array<{ s: number; e: number }> = [];
      for (const item of rawEntries) {
        if (!item || typeof item !== 'object') continue;
        const s = item.startSec ?? item.start ?? item.start_time;
        const e = item.endSec ?? item.end ?? item.end_time;
        if (typeof s === 'number' && typeof e === 'number' && Number.isFinite(s) && Number.isFinite(e)) {
          sampleNumeric.push({ s, e });
        }
      }
      if (sampleNumeric.length > 0) {
        const allIntegers = sampleNumeric.every(
          (p) => Number.isInteger(p.s) && Number.isInteger(p.e)
        );
        const avgSpan =
          sampleNumeric.reduce((acc, p) => acc + (p.e - p.s), 0) / sampleNumeric.length;
        const maxEnd = Math.max(...sampleNumeric.map((p) => p.e));
        if (allIntegers && (avgSpan >= 40 || maxEnd >= 10_000)) {
          isMsScale = true;
        }
      }
    }
  }

  const normalised: TranscriptWordTimestamp[] = [];
  let prevStart = -1;
  let prevEnd = -1;

  for (let i = 0; i < rawEntries.length; i++) {
    const item = rawEntries[i];
    if (!item || typeof item !== 'object') {
      throw createTranscriptInvalidError('Word entry is not an object', i);
    }

    const rawWord = item.word ?? item.text ?? item.token;
    const rawStart = item.startMs ?? item.startSec ?? item.start ?? item.start_time;
    const rawEnd = item.endMs ?? item.endSec ?? item.end ?? item.end_time;

    if (rawWord === null || rawWord === undefined || String(rawWord).trim().length === 0) {
      throw createTranscriptInvalidError('Missing or empty word text', i);
    }
    if (
      rawStart === null ||
      rawStart === undefined ||
      rawEnd === null ||
      rawEnd === undefined ||
      typeof rawStart === 'boolean' ||
      typeof rawEnd === 'boolean'
    ) {
      throw createTranscriptInvalidError('Null or missing timestamp value', i);
    }

    const startNum = Number(rawStart);
    const endNum = Number(rawEnd);

    if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) {
      throw createTranscriptInvalidError('NaN or non-finite timestamp value', i);
    }
    if (startNum < 0 || endNum < 0) {
      throw createTranscriptInvalidError('Negative timestamp value', i);
    }
    if (endNum < startNum) {
      throw createTranscriptInvalidError(`end (${endNum}) < start (${startNum})`, i);
    }

    const scale = isMsScale ? 1000 : 1;
    const startSec = Number((startNum / scale).toFixed(3));
    const endSec = Number((endNum / scale).toFixed(3));

    if (i > 0 && (startSec < prevStart - 1e-3 || startSec < prevEnd - 0.05)) {
      throw createTranscriptInvalidError(
        `Non-monotonic timestamp at index ${i}: startSec=${startSec} < previous endSec=${prevEnd}`,
        i
      );
    }

    prevStart = startSec;
    prevEnd = endSec;

    const subWords = splitWords(stripSubtitleMarkup(String(rawWord)));
    if (subWords.length === 0) {
      throw createTranscriptInvalidError('Word text empty after stripping tags', i);
    }

    if (subWords.length === 1) {
      normalised.push({
        word: subWords[0],
        startSec,
        endSec: Math.max(startSec, endSec),
      });
    } else {
      const span = Math.max(0, endSec - startSec);
      const step = span / subWords.length;
      subWords.forEach((w, subIdx) => {
        const wStart = Number((startSec + subIdx * step).toFixed(3));
        const wEnd =
          subIdx === subWords.length - 1
            ? endSec
            : Number((startSec + (subIdx + 1) * step).toFixed(3));
        normalised.push({ word: w, startSec: wStart, endSec: wEnd });
      });
    }
  }

  return normalised;
}

/**
 * Parses WebVTT, SRT, or JSON transcripts (`{word,start,end}`, `{word,startSec,endSec}`,
 * `{text,start,end}`, `{start_time,end_time}`, ms integers, WhisperX `{segments:[{words:[...]}]}`,
 * Descript `{words:[...]}`).
 * Throws typed `TRANSCRIPT_INVALID` on malformed, plain-text, null/NaN, negative, or non-monotonic inputs.
 */
export function parseTranscriptInput(
  rawInput: string | ReadonlyArray<TranscriptWordTimestamp | RawJsonWordEntry>
): TranscriptWordTimestamp[] {
  if (Array.isArray(rawInput)) {
    return validateAndNormaliseWordEntries(rawInput as ReadonlyArray<RawJsonWordEntry>);
  }

  const trimmed = String(rawInput ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    throw createTranscriptInvalidError('Transcript input is empty.');
  }

  // 1. JSON formats
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw createTranscriptInvalidError(
        `Malformed JSON transcript: ${(err as Error)?.message || 'parse error'}`
      );
    }

    if (Array.isArray(parsed)) {
      return validateAndNormaliseWordEntries(parsed as RawJsonWordEntry[]);
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as {
        unit?: string;
        timeUnit?: string;
        words?: RawJsonWordEntry[];
        segments?: Array<{
          words?: RawJsonWordEntry[];
          text?: unknown;
          start?: unknown;
          end?: unknown;
        }>;
      };
      const forceMs =
        String(obj.unit || obj.timeUnit || '').toLowerCase() === 'ms' ||
        String(obj.unit || obj.timeUnit || '').toLowerCase() === 'milliseconds';

      if (Array.isArray(obj.words)) {
        return validateAndNormaliseWordEntries(obj.words, forceMs);
      }

      if (Array.isArray(obj.segments)) {
        const flatWords: RawJsonWordEntry[] = [];
        for (let sIdx = 0; sIdx < obj.segments.length; sIdx++) {
          const seg = obj.segments[sIdx];
          if (seg && Array.isArray(seg.words) && seg.words.length > 0) {
            flatWords.push(...seg.words);
          } else if (seg && seg.text !== undefined) {
            flatWords.push({
              text: seg.text,
              start: seg.start,
              end: seg.end,
            });
          }
        }
        return validateAndNormaliseWordEntries(flatWords, forceMs);
      }
    }

    throw createTranscriptInvalidError(
      'JSON transcript must be an array of word objects, { words: [...] }, or WhisperX { segments: [...] }.'
    );
  }

  // 2. WebVTT / SRT cue parsing
  if (!trimmed.includes('-->')) {
    throw createTranscriptInvalidError(
      'Plain text without timestamps is not allowed. Upload a timed WebVTT, SRT, or JSON transcript.'
    );
  }

  const withoutHeader = trimmed.replace(/^WEBVTT[^\r\n]*(\r?\n|$)/i, '');
  const rawBlocks = withoutHeader
    .split(/\r?\n\s*\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const result: TranscriptWordTimestamp[] = [];
  let prevCueEnd = 0;
  let cueCounter = 0;

  for (const block of rawBlocks) {
    // Skip WebVTT NOTE / STYLE / REGION metadata blocks
    if (/^(NOTE|STYLE|REGION)(\s|$)/i.test(block)) {
      continue;
    }

    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const arrowLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowLineIdx === -1) continue;

    const arrowLine = lines[arrowLineIdx].trim();
    const match = arrowLine.match(/^\s*(\S+)\s*-->\s*(\S+)/);
    if (!match) {
      throw createTranscriptInvalidError(`Malformed cue timecode line "${arrowLine}"`, cueCounter);
    }

    const blockStart = parseTimecodeToSec(match[1]);
    const blockEnd = parseTimecodeToSec(match[2]);

    if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd)) {
      throw createTranscriptInvalidError(
        `Invalid timecode in "${arrowLine}"`,
        cueCounter
      );
    }
    if (blockStart < 0 || blockEnd < 0 || blockEnd <= blockStart) {
      throw createTranscriptInvalidError(
        `Cue end (${blockEnd}) must be greater than cue start (${blockStart})`,
        cueCounter
      );
    }
    if (cueCounter > 0 && blockStart < prevCueEnd - 0.05) {
      throw createTranscriptInvalidError(
        `Non-monotonic cue start (${blockStart} < previous cue end ${prevCueEnd})`,
        cueCounter
      );
    }

    const rawText = lines.slice(arrowLineIdx + 1).join(' ');
    const cleanText = stripSubtitleMarkup(rawText);
    const words = splitWords(cleanText);
    if (words.length === 0) {
      cueCounter += 1;
      prevCueEnd = blockEnd;
      continue;
    }

    const span = blockEnd - blockStart;
    const step = span / words.length;

    words.forEach((word, idx) => {
      const wStart = blockStart + idx * step;
      const wEnd = idx === words.length - 1 ? blockEnd : blockStart + (idx + 1) * step;
      result.push({
        word,
        startSec: Number(wStart.toFixed(3)),
        endSec: Number(wEnd.toFixed(3)),
      });
    });

    prevCueEnd = blockEnd;
    cueCounter += 1;
  }

  if (result.length === 0) {
    throw createTranscriptInvalidError('Unable to parse any timed words from transcript.');
  }

  return result;
}

export function sliceTranscriptTimeline(config: SlicerConfig): StoryboardSlot[] {
  const {
    words,
    mode,
    provider = 'VEO_3_1',
    defaultClipDuration = 8,
    preferredCutRangeSec,
  } = config;
  if (!words || words.length === 0) {
    throw createTranscriptInvalidError('Cannot slice an empty word timestamp array.');
  }

  const pacing = resolveModelLockedPacing({
    mode,
    provider,
    durationSec: defaultClipDuration,
  });

  // Model-locked hard bounds always win; DNA preferredCutRangeSec is clamped inside [minSec, maxSec]
  const minSec = pacing.minSec;
  const maxSec = pacing.maxSec;
  let targetSec = Number(((minSec + maxSec) / 2).toFixed(3));
  if (
    preferredCutRangeSec &&
    Array.isArray(preferredCutRangeSec) &&
    preferredCutRangeSec.length === 2 &&
    Number.isFinite(preferredCutRangeSec[0]) &&
    Number.isFinite(preferredCutRangeSec[1])
  ) {
    const prefMid = (preferredCutRangeSec[0] + preferredCutRangeSec[1]) / 2;
    targetSec = Number(Math.max(minSec, Math.min(maxSec, prefMid)).toFixed(3));
  }

  interface RawChunk {
    words: TranscriptWordTimestamp[];
    startSec: number;
    endSec: number;
  }

  const rawChunks: RawChunk[] = [];
  let currentWords: TranscriptWordTimestamp[] = [];
  let chunkStart = words[0].startSec;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (currentWords.length === 0) {
      chunkStart = w.startSec;
    }
    currentWords.push(w);

    const currentDur = w.endSec - chunkStart;
    const nextWord = words[i + 1];
    const nextDur = nextWord ? nextWord.endSec - chunkStart : currentDur;
    const isPunctuationBoundary = /[।?!.,;]$/.test(w.word);

    if (
      (currentDur >= minSec && isPunctuationBoundary && currentDur >= targetSec * 0.78) ||
      currentDur >= targetSec ||
      (nextWord && nextDur > maxSec)
    ) {
      rawChunks.push({
        words: currentWords,
        startSec: chunkStart,
        endSec: w.endSec,
      });
      currentWords = [];
    }
  }

  if (currentWords.length > 0) {
    rawChunks.push({
      words: currentWords,
      startSec: chunkStart,
      endSec: currentWords[currentWords.length - 1].endSec,
    });
  }

  // Make chunks contiguous
  for (let i = 1; i < rawChunks.length; i++) {
    rawChunks[i].startSec = rawChunks[i - 1].endSec;
  }

  // Pass 1: Split any chunk > maxSec into equal sub-chunks inside [minSec, maxSec]
  const splitChecked: RawChunk[] = [];
  for (const chunk of rawChunks) {
    const dur = chunk.endSec - chunk.startSec;
    if (dur <= maxSec + 1e-6) {
      splitChecked.push(chunk);
      continue;
    }
    const parts = Math.max(2, Math.ceil(dur / maxSec));
    const stepDur = dur / parts;
    const wordsPerPart = Math.max(1, Math.ceil(chunk.words.length / parts));
    for (let p = 0; p < parts; p++) {
      const pStart = chunk.startSec + p * stepDur;
      const pEnd = p === parts - 1 ? chunk.endSec : chunk.startSec + (p + 1) * stepDur;
      const sliceWords = chunk.words.slice(p * wordsPerPart, (p + 1) * wordsPerPart);
      splitChecked.push({
        words: sliceWords.length > 0 ? sliceWords : [chunk.words[chunk.words.length - 1]],
        startSec: Number(pStart.toFixed(3)),
        endSec: Number(pEnd.toFixed(3)),
      });
    }
  }

  // Pass 2: Merge/rebalance any chunk < minSec with neighbor so 0 slots < minSec and 0 slots > maxSec
  let idx = 0;
  while (idx < splitChecked.length && splitChecked.length > 1) {
    const curr = splitChecked[idx];
    const currDur = curr.endSec - curr.startSec;
    if (currDur >= minSec - 1e-6) {
      idx += 1;
      continue;
    }

    const neighborIdx = idx > 0 ? idx - 1 : idx + 1;
    const firstIdx = Math.min(idx, neighborIdx);
    const secondIdx = Math.max(idx, neighborIdx);
    const first = splitChecked[firstIdx];
    const second = splitChecked[secondIdx];
    const combinedStart = first.startSec;
    const combinedEnd = second.endSec;
    const combinedDur = combinedEnd - combinedStart;
    const combinedWords = [...first.words, ...second.words];

    if (combinedDur >= minSec && combinedDur <= maxSec) {
      splitChecked.splice(firstIdx, 2, {
        words: combinedWords,
        startSec: combinedStart,
        endSec: combinedEnd,
      });
    } else if (combinedDur >= 2 * minSec && combinedDur <= 2 * maxSec) {
      const midTime = Number((combinedStart + combinedDur / 2).toFixed(3));
      const midWordIdx = Math.max(1, Math.floor(combinedWords.length / 2));
      splitChecked.splice(
        firstIdx,
        2,
        {
          words: combinedWords.slice(0, midWordIdx),
          startSec: combinedStart,
          endSec: midTime,
        },
        {
          words: combinedWords.slice(midWordIdx),
          startSec: midTime,
          endSec: combinedEnd,
        }
      );
      idx += 1;
    } else if (splitChecked.length >= 3) {
      const start3 = firstIdx > 0 ? firstIdx - 1 : firstIdx;
      const group = splitChecked.slice(start3, start3 + 3);
      const gStart = group[0].startSec;
      const gEnd = group[group.length - 1].endSec;
      const gDur = gEnd - gStart;
      const gWords = group.flatMap((g) => g.words);
      let k = 2;
      if (gDur / 2 > maxSec) {
        k = Math.max(3, Math.ceil(gDur / maxSec));
      } else if (gDur / 2 < minSec) {
        k = 1;
      }
      const stepD = gDur / k;
      const wPerPart = Math.max(1, Math.ceil(gWords.length / k));
      const replacement: RawChunk[] = [];
      for (let p = 0; p < k; p++) {
        const pStart = p === 0 ? gStart : Number((gStart + p * stepD).toFixed(3));
        const pEnd = p === k - 1 ? gEnd : Number((gStart + (p + 1) * stepD).toFixed(3));
        const sliceW = gWords.slice(p * wPerPart, (p + 1) * wPerPart);
        replacement.push({
          words: sliceW.length > 0 ? sliceW : [gWords[gWords.length - 1]],
          startSec: pStart,
          endSec: pEnd,
        });
      }
      splitChecked.splice(start3, group.length, ...replacement);
      idx = Math.max(0, start3);
    } else {
      const midTime = Number((combinedStart + combinedDur / 2).toFixed(3));
      const midWordIdx = Math.max(1, Math.floor(combinedWords.length / 2));
      splitChecked.splice(
        firstIdx,
        2,
        {
          words: combinedWords.slice(0, midWordIdx),
          startSec: combinedStart,
          endSec: midTime,
        },
        {
          words: combinedWords.slice(midWordIdx),
          startSec: midTime,
          endSec: combinedEnd,
        }
      );
      idx += 1;
    }
  }

  return splitChecked.map((chunk, i): StoryboardSlot => {
    const firstWord = chunk.words[0];
    const lastWord = chunk.words[chunk.words.length - 1];
    const startMs = typeof firstWord?.startMs === 'number'
      ? firstWord.startMs
      : Math.round(chunk.startSec * 1000);
    const endMs = typeof lastWord?.endMs === 'number'
      ? lastWord.endMs
      : Math.round(chunk.endSec * 1000);
    const durationMs = Math.max(100, endMs - startMs);
    const actionMs = Math.round(durationMs * pacing.actionRatio);
    const holdMs = durationMs - actionMs;

    const startSec = Number((startMs / 1000).toFixed(3));
    const endSec = Number((endMs / 1000).toFixed(3));
    const durationSec = Number((durationMs / 1000).toFixed(3));
    const actionSec = Number((actionMs / 1000).toFixed(3));
    const holdSec = Number((holdMs / 1000).toFixed(3));
    const spokenSegment = chunk.words.map((w) => w.word).join(' ').trim();

    return {
      slotIndex: i + 1,
      startSec,
      endSec,
      durationSec,
      actionSec,
      holdSec,
      startMs,
      endMs,
      durationMs,
      actionMs,
      holdMs,
      spokenSegment,
      wordCount: chunk.words.length,
      timestampTag: formatTimestampTag(startMs, 'bracketed', true),
      rangeLabel: formatRangeLabel(startMs, endMs, true),
    };
  });
}

function secToSrtTimecode(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function formatTimedWordsToSrt(words: ReadonlyArray<TranscriptWordTimestamp>): string {
  const lines: string[] = [];
  const chunkSize = 8;
  let cueIndex = 1;
  for (let i = 0; i < words.length; i += chunkSize) {
    const slice = words.slice(i, i + chunkSize);
    const start = secToSrtTimecode(slice[0].startSec);
    const end = secToSrtTimecode(slice[slice.length - 1].endSec);
    const text = slice.map((w) => w.word).join(' ');
    lines.push(`${cueIndex}\n${start} --> ${end}\n${text}`);
    cueIndex += 1;
  }
  return lines.join('\n\n') + '\n';
}

export function formatStoryboardCsv(slots: ReadonlyArray<StoryboardSlot>): string {
  const header = 'slot_index,start_sec,end_sec,duration_sec,action_sec,hold_sec,word_count,spoken_segment';
  const rows = slots.map((s) => {
    const escapedText = `"${s.spokenSegment.replace(/"/g, '""')}"`;
    return [
      s.slotIndex,
      s.startSec.toFixed(3),
      s.endSec.toFixed(3),
      s.durationSec.toFixed(3),
      s.actionSec.toFixed(3),
      s.holdSec.toFixed(3),
      s.wordCount,
      escapedText,
    ].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}
