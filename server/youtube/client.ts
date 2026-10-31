import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CHANNEL_CACHE_TTL_MS,
  CHANNEL_MIN_PUBLIC_VIDEOS,
  CHANNEL_SAMPLE_COUNTS,
  REFERENCE_SIMILARITY_MAX,
  type ChannelAnalysisDepth,
} from '../../src/config/constants.ts';
import { getActiveDecryptedKeys } from '../llm/keyPool.ts';
import { splitHindiSentences, splitWords } from '../../shared/rules/math.ts';
import {
  parseTranscriptInput,
  type TranscriptWordTimestamp,
} from '../../shared/rules/slicer.ts';

export interface YouTubeVideoMeta {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  views: number;
  durationSec?: number;
  thumbnailUrl?: string;
  channelId?: string;
  channelTitle?: string;
  transcriptText?: string;
  transcriptWords?: TranscriptWordTimestamp[];
  transcriptSource?: 'CAPTIONS' | 'GEMINI_MULTIMODAL' | 'USER_UPLOAD' | 'UNKNOWN';
}

export type ChannelVideoItem = YouTubeVideoMeta;

export type SampleSlotRole = 'OUTLIER' | 'MEDIAN' | 'LOWEST' | 'NEWEST';

export interface SampledChannelVideo extends YouTubeVideoMeta {
  sampleRole: SampleSlotRole;
  outlierRatio: number;
}

export interface EvidenceCitation {
  videoId: string;
  quoteOrTimestamp: string;
}

export interface EvidenceBackedClaim<T = string> {
  claim: T;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  evidence: EvidenceCitation[];
}

export interface DeterministicChannelStats {
  videoCount: number;
  medianViews: number;
  titleStats: {
    minChars: number;
    maxChars: number;
    meanChars: number;
    medianChars: number;
    questionRatio: number;
    numberRatio: number;
  };
  sentenceStats: {
    hasTranscriptData: boolean;
    minWords: number | null;
    maxWords: number | null;
    meanWords: number | null;
    p20Words: number | null;
    p80Words: number | null;
  };
  wpmStats: {
    hasTimedWords: boolean;
    measuredWpm: number | null;
    confidence: 'HIGH' | 'LOW';
  };
  cadence: {
    avgGapDays: number | null;
    label: string;
  };
}

export function createYouTubeError(
  code:
    | 'CHANNEL_NOT_FOUND'
    | 'CHANNEL_PRIVATE'
    | 'CHANNEL_TOO_SMALL'
    | 'NO_TRANSCRIPT_SOURCE'
    | 'YOUTUBE_QUOTA'
    | 'VIDEO_NOT_ANALYSABLE'
    | 'REFERENCE_SIMILARITY_EXCEEDED',
  message: string,
  statusCode: number = 422
): Error & { code: string; statusCode: number } {
  const err = new Error(`${code}: ${message}`) as Error & {
    code: string;
    statusCode: number;
  };
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

/**
 * Extracts a canonical channel identifier or handle from a URL or raw string.
 */
export function parseChannelIdentifier(input: string): {
  kind: 'CHANNEL_ID' | 'HANDLE' | 'VIDEO_URLS' | 'UNKNOWN';
  value: string;
  videoIds?: string[];
} {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    return { kind: 'UNKNOWN', value: '' };
  }

  // Check if multiple video URLs were pasted
  const videoIdMatches = Array.from(
    trimmed.matchAll(/(?:v=|youtu\.be\/|shorts\/)([0-9A-Za-z_-]{11})/g)
  ).map((m) => m[1]);
  if (videoIdMatches.length >= 2) {
    return {
      kind: 'VIDEO_URLS',
      value: videoIdMatches[0],
      videoIds: Array.from(new Set(videoIdMatches)),
    };
  }

  const ucMatch = trimmed.match(/\b(UC[0-9A-Za-z_-]{6,30})\b/);
  if (ucMatch) {
    return { kind: 'CHANNEL_ID', value: ucMatch[1] };
  }

  const handleMatch = trimmed.match(/@([0-9A-Za-z_.-]{2,50})/);
  if (handleMatch) {
    return { kind: 'HANDLE', value: `@${handleMatch[1]}` };
  }

  if (/^[0-9A-Za-z_.-]{3,40}$/.test(trimmed)) {
    return { kind: 'HANDLE', value: trimmed.startsWith('@') ? trimmed : `@${trimmed}` };
  }

  return { kind: 'UNKNOWN', value: trimmed };
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Parses YouTube public Atom/RSS feed XML (`https://www.youtube.com/feeds/videos.xml?channel_id=...`).
 */
export function parseYouTubeRssXml(xmlText: string): {
  channelId: string;
  channelTitle: string;
  videos: YouTubeVideoMeta[];
} {
  const text = String(xmlText || '').trim();
  if (!text || (!text.includes('<feed') && !text.includes('<entry>'))) {
    throw createYouTubeError('CHANNEL_NOT_FOUND', 'Invalid or empty YouTube RSS feed XML.', 404);
  }

  const channelIdMatch =
    text.match(/<yt:channelId>([^<]+)<\/yt:channelId>/i) ||
    text.match(/channel_id=([^"&<\s]+)/i);
  const feedTitleMatch = text.match(/<title>([^<]+)<\/title>/i);

  const channelId = channelIdMatch ? decodeXmlEntities(channelIdMatch[1].trim()) : 'UC_UNKNOWN';
  const channelTitle = feedTitleMatch
    ? decodeXmlEntities(feedTitleMatch[1].trim())
    : 'YouTube Channel';

  const entries = Array.from(text.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)).map((m) => m[1]);
  const videos: YouTubeVideoMeta[] = [];

  for (const entry of entries) {
    const vidMatch =
      entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/i) ||
      entry.match(/<id>yt:video:([^<]+)<\/id>/i);
    if (!vidMatch) continue;
    const videoId = decodeXmlEntities(vidMatch[1].trim());
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
    const pubMatch = entry.match(/<published>([^<]+)<\/published>/i);
    const descMatch = entry.match(/<media:description>([\s\S]*?)<\/media:description>/i);
    const viewsMatch = entry.match(/<media:statistics[^>]*views=["'](\d+)["']/i);
    const thumbMatch = entry.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i);

    videos.push({
      videoId,
      title: titleMatch ? decodeXmlEntities(titleMatch[1].trim()) : `Video ${videoId}`,
      description: descMatch ? decodeXmlEntities(descMatch[1].trim()) : '',
      publishedAt: pubMatch ? pubMatch[1].trim() : new Date().toISOString(),
      views: viewsMatch ? Number.parseInt(viewsMatch[1], 10) : 0,
      thumbnailUrl: thumbMatch ? thumbMatch[1].trim() : undefined,
      channelId,
      channelTitle,
      transcriptSource: 'UNKNOWN',
    });
  }

  return { channelId, channelTitle, videos };
}

export function computeMedian(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Deterministic sample selector (C2 Step 2):
 * `outliers = top 3 by (views ÷ channel median views)`, `2 median-performing`,
 * `1 lowest-performing`, `2 newest` (8 for Standard, 15 for Deep, 4 for Quick).
 * Throws `CHANNEL_TOO_SMALL` if < 5 public videos.
 */
export function selectDeterministicChannelSample(
  videos: ReadonlyArray<YouTubeVideoMeta>,
  depth: ChannelAnalysisDepth = 'STANDARD'
): {
  medianViews: number;
  sampled: SampledChannelVideo[];
  outliers: SampledChannelVideo[];
  medians: SampledChannelVideo[];
  lowest: SampledChannelVideo[];
  newest: SampledChannelVideo[];
} {
  if (!Array.isArray(videos) || videos.length < CHANNEL_MIN_PUBLIC_VIDEOS) {
    throw createYouTubeError(
      'CHANNEL_TOO_SMALL',
      `Channel has ${videos?.length ?? 0} public videos (minimum ${CHANNEL_MIN_PUBLIC_VIDEOS} required). Use Hybrid / Reference Channel mode instead.`,
      422
    );
  }

  const rawMedian = computeMedian(videos.map((v) => Math.max(0, Number(v.views) || 0)));
  const safeMedian = rawMedian > 0 ? rawMedian : 1;

  const annotated: SampledChannelVideo[] = videos.map((v) => ({
    ...v,
    sampleRole: 'MEDIAN',
    outlierRatio: Number((Math.max(0, Number(v.views) || 0) / safeMedian).toFixed(3)),
  }));

  const byRatioDesc = [...annotated].sort(
    (a, b) => b.outlierRatio - a.outlierRatio || b.views - a.views || a.videoId.localeCompare(b.videoId)
  );
  const byViewsAsc = [...annotated].sort(
    (a, b) => a.views - b.views || a.videoId.localeCompare(b.videoId)
  );
  const byDistFromMedian = [...annotated].sort(
    (a, b) =>
      Math.abs(a.views - rawMedian) - Math.abs(b.views - rawMedian) ||
      a.videoId.localeCompare(b.videoId)
  );
  const byNewest = [...annotated].sort(
    (a, b) =>
      Date.parse(b.publishedAt || '1970-01-01') - Date.parse(a.publishedAt || '1970-01-01') ||
      a.videoId.localeCompare(b.videoId)
  );

  const usedIds = new Set<string>();
  const outliers: SampledChannelVideo[] = [];
  const medians: SampledChannelVideo[] = [];
  const lowest: SampledChannelVideo[] = [];
  const newest: SampledChannelVideo[] = [];

  const targetCount = Math.min(videos.length, CHANNEL_SAMPLE_COUNTS[depth] ?? 8);
  const outlierTarget = depth === 'QUICK' ? 2 : 3;
  const medianTarget = depth === 'QUICK' ? 1 : 2;
  const lowestTarget = 1;
  const newestTarget = depth === 'QUICK' ? 0 : 2;

  for (const v of byRatioDesc) {
    if (outliers.length >= outlierTarget) break;
    if (!usedIds.has(v.videoId)) {
      const item: SampledChannelVideo = { ...v, sampleRole: 'OUTLIER' };
      outliers.push(item);
      usedIds.add(v.videoId);
    }
  }

  for (const v of byDistFromMedian) {
    if (medians.length >= medianTarget) break;
    if (!usedIds.has(v.videoId)) {
      const item: SampledChannelVideo = { ...v, sampleRole: 'MEDIAN' };
      medians.push(item);
      usedIds.add(v.videoId);
    }
  }

  for (const v of byViewsAsc) {
    if (lowest.length >= lowestTarget) break;
    if (!usedIds.has(v.videoId)) {
      const item: SampledChannelVideo = { ...v, sampleRole: 'LOWEST' };
      lowest.push(item);
      usedIds.add(v.videoId);
    }
  }

  for (const v of byNewest) {
    if (newest.length >= newestTarget) break;
    if (!usedIds.has(v.videoId)) {
      const item: SampledChannelVideo = { ...v, sampleRole: 'NEWEST' };
      newest.push(item);
      usedIds.add(v.videoId);
    }
  }

  const sampled: SampledChannelVideo[] = [...outliers, ...medians, ...lowest, ...newest];

  // If DEEP (15) or any remaining slots needed, fill deterministically from byRatioDesc
  for (const v of byRatioDesc) {
    if (sampled.length >= targetCount) break;
    if (!usedIds.has(v.videoId)) {
      sampled.push({ ...v, sampleRole: 'MEDIAN' });
      usedIds.add(v.videoId);
    }
  }

  return {
    medianViews: rawMedian,
    sampled: sampled.slice(0, targetCount),
    outliers,
    medians,
    lowest,
    newest,
  };
}

/**
 * Computes all numeric statistics in code from real video titles, publish dates,
 * and transcripts/word timings. Never fabricates numbers when transcript data is missing.
 */
export function computeDeterministicVideoStats(
  videos: ReadonlyArray<YouTubeVideoMeta>
): DeterministicChannelStats {
  if (videos.length === 0) {
    return {
      videoCount: 0,
      medianViews: 0,
      titleStats: {
        minChars: 0,
        maxChars: 0,
        meanChars: 0,
        medianChars: 0,
        questionRatio: 0,
        numberRatio: 0,
      },
      sentenceStats: {
        hasTranscriptData: false,
        minWords: null,
        maxWords: null,
        meanWords: null,
        p20Words: null,
        p80Words: null,
      },
      wpmStats: {
        hasTimedWords: false,
        measuredWpm: null,
        confidence: 'LOW',
      },
      cadence: {
        avgGapDays: null,
        label: 'UNKNOWN',
      },
    };
  }

  const medianViews = computeMedian(videos.map((v) => Math.max(0, v.views || 0)));

  // 1. Title stats
  const titleLengths = videos.map((v) => v.title.trim().length).sort((a, b) => a - b);
  const minChars = titleLengths[0] ?? 0;
  const maxChars = titleLengths[titleLengths.length - 1] ?? 0;
  const meanChars = Number(
    (titleLengths.reduce((acc, n) => acc + n, 0) / titleLengths.length).toFixed(1)
  );
  const medianChars = Number(computeMedian(titleLengths).toFixed(1));
  const questionCount = videos.filter(
    (v) => v.title.includes('?') || /\b(why|how|what|who|क्यों|कैसे|क्या)\b/i.test(v.title)
  ).length;
  const numberCount = videos.filter((v) => /\d/.test(v.title)).length;

  // 2. Sentence stats from transcripts
  const sentenceWordCounts: number[] = [];
  for (const v of videos) {
    const rawTxt =
      v.transcriptText?.trim() ||
      (v.transcriptWords && v.transcriptWords.length > 0
        ? v.transcriptWords.map((w) => w.word).join(' ')
        : '');
    if (!rawTxt) continue;
    const sents = splitHindiSentences(rawTxt);
    for (const s of sents) {
      const wc = splitWords(s.replace(/[।?!.,;:]/g, '')).length;
      if (wc >= 3) {
        sentenceWordCounts.push(wc);
      }
    }
  }

  let sentenceStats: DeterministicChannelStats['sentenceStats'] = {
    hasTranscriptData: false,
    minWords: null,
    maxWords: null,
    meanWords: null,
    p20Words: null,
    p80Words: null,
  };

  if (sentenceWordCounts.length > 0) {
    const sortedSents = [...sentenceWordCounts].sort((a, b) => a - b);
    const p20Idx = Math.max(0, Math.floor(sortedSents.length * 0.2));
    const p80Idx = Math.min(sortedSents.length - 1, Math.floor(sortedSents.length * 0.8));
    const meanW =
      sortedSents.reduce((acc, n) => acc + n, 0) / sortedSents.length;
    sentenceStats = {
      hasTranscriptData: true,
      minWords: sortedSents[0],
      maxWords: sortedSents[sortedSents.length - 1],
      meanWords: Number(meanW.toFixed(1)),
      p20Words: sortedSents[p20Idx],
      p80Words: sortedSents[p80Idx],
    };
  }

  // 3. WPM from timed words
  const videoWpms: number[] = [];
  for (const v of videos) {
    if (v.transcriptWords && v.transcriptWords.length >= 10) {
      const start = v.transcriptWords[0].startSec;
      const end = v.transcriptWords[v.transcriptWords.length - 1].endSec;
      const spanSec = end - start;
      if (spanSec > 5) {
        videoWpms.push((v.transcriptWords.length / spanSec) * 60);
      }
    } else if (v.transcriptText && v.durationSec && v.durationSec > 10) {
      const wc = splitWords(v.transcriptText).length;
      if (wc >= 20) {
        videoWpms.push((wc / v.durationSec) * 60);
      }
    }
  }

  const wpmStats: DeterministicChannelStats['wpmStats'] =
    videoWpms.length > 0
      ? {
          hasTimedWords: true,
          measuredWpm: Number(
            (videoWpms.reduce((a, b) => a + b, 0) / videoWpms.length).toFixed(2)
          ),
          confidence: 'HIGH',
        }
      : {
          hasTimedWords: false,
          measuredWpm: null,
          confidence: 'LOW',
        };

  // 4. Upload cadence from publishedAt dates
  const timestamps = videos
    .map((v) => Date.parse(v.publishedAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a);

  let avgGapDays: number | null = null;
  let cadenceLabel = 'UNKNOWN';
  if (timestamps.length >= 2) {
    const gapsDays: number[] = [];
    for (let i = 0; i < timestamps.length - 1; i++) {
      const diffDays = (timestamps[i] - timestamps[i + 1]) / (1000 * 60 * 60 * 24);
      if (diffDays >= 0) {
        gapsDays.push(diffDays);
      }
    }
    if (gapsDays.length > 0) {
      avgGapDays = Number(
        (gapsDays.reduce((a, b) => a + b, 0) / gapsDays.length).toFixed(1)
      );
      if (avgGapDays <= 1.5) cadenceLabel = 'daily';
      else if (avgGapDays <= 4) cadenceLabel = '2-3x/week';
      else if (avgGapDays <= 9) cadenceLabel = 'weekly';
      else if (avgGapDays <= 18) cadenceLabel = 'biweekly';
      else cadenceLabel = 'monthly';
    }
  }

  return {
    videoCount: videos.length,
    medianViews,
    titleStats: {
      minChars,
      maxChars,
      meanChars,
      medianChars,
      questionRatio: Number((questionCount / videos.length).toFixed(2)),
      numberRatio: Number((numberCount / videos.length).toFixed(2)),
    },
    sentenceStats,
    wpmStats,
    cadence: {
      avgGapDays,
      label: cadenceLabel,
    },
  };
}

/**
 * Drops any qualitative claim that does not cite at least one valid `{ videoId, quoteOrTimestamp }`
 * evidence item (C2 Step 4 & T10).
 */
export function filterClaimsRequiringEvidence<T>(
  claims: ReadonlyArray<EvidenceBackedClaim<T>>
): EvidenceBackedClaim<T>[] {
  if (!Array.isArray(claims)) return [];
  return claims.filter((item) => {
    if (!item || !Array.isArray(item.evidence) || item.evidence.length === 0) {
      return false;
    }
    const validCitations = item.evidence.filter(
      (ev: { videoId: string; quoteOrTimestamp: string }) =>
        ev &&
        typeof ev.videoId === 'string' &&
        ev.videoId.trim().length > 0 &&
        typeof ev.quoteOrTimestamp === 'string' &&
        ev.quoteOrTimestamp.trim().length > 0
    );
    return validCitations.length > 0;
  });
}

/**
 * Computes normalized token + character 3-gram similarity in [0, 1] between two strings (C4 & T12).
 */
export function computeTextSimilarity(textA: string, textB: string): number {
  const norm = (s: string) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const a = norm(textA);
  const b = norm(textB);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  let wordIntersect = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) wordIntersect += 1;
  }
  const wordUnion = wordsA.size + wordsB.size - wordIntersect;
  const wordJaccard = wordUnion > 0 ? wordIntersect / wordUnion : 0;

  const ngrams = (s: string, n: number = 3): Set<string> => {
    const set = new Set<string>();
    const padded = ` ${s} `;
    for (let i = 0; i <= padded.length - n; i++) {
      set.add(padded.slice(i, i + n));
    }
    return set;
  };

  const gramsA = ngrams(a, 3);
  const gramsB = ngrams(b, 3);
  let gramIntersect = 0;
  for (const g of gramsA) {
    if (gramsB.has(g)) gramIntersect += 1;
  }
  const gramUnion = gramsA.size + gramsB.size - gramIntersect;
  const gramJaccard = gramUnion > 0 ? gramIntersect / gramUnion : 0;

  return Number(Math.max(wordJaccard, (wordJaccard + gramJaccard) / 2).toFixed(4));
}

export function checkReferenceSimilarity(
  candidateText: string,
  referenceTexts: ReadonlyArray<string>,
  maxAllowed: number = REFERENCE_SIMILARITY_MAX
): {
  passed: boolean;
  maxSimilarity: number;
  closestReference: string | null;
  threshold: number;
} {
  let maxSim = 0;
  let closest: string | null = null;

  for (const ref of referenceTexts) {
    const sim = computeTextSimilarity(candidateText, ref);
    if (sim > maxSim) {
      maxSim = sim;
      closest = ref;
    }
  }

  return {
    passed: maxSim <= maxAllowed,
    maxSimilarity: maxSim,
    closestReference: closest,
    threshold: maxAllowed,
  };
}

/**
 * Fetches channel videos using:
 * (1) Optional YouTube Data API v3 key in Vault (`key_type='YOUTUBE'`) ->
 * (2) Public RSS feed (`https://www.youtube.com/feeds/videos.xml?channel_id=...`) ->
 * (3) Manual video objects / transcripts passed in request.
 * Caches fetched video metadata in `channel_videos` with 24h TTL.
 */
export async function fetchChannelVideosWithCache(params: {
  db: DatabaseSync;
  projectId: string;
  channelInput: string;
  manualVideos?: ReadonlyArray<Partial<YouTubeVideoMeta>>;
  uploadedTranscripts?: Record<string, string>;
  customFetch?: typeof fetch;
}): Promise<{
  channelId: string;
  channelTitle: string;
  videos: YouTubeVideoMeta[];
}> {
  const {
    db,
    projectId,
    channelInput,
    manualVideos,
    uploadedTranscripts,
    customFetch = fetch,
  } = params;

  const attachUploadedTranscripts = (list: YouTubeVideoMeta[]): YouTubeVideoMeta[] => {
    return list.map((v) => {
      const rawUpload = uploadedTranscripts?.[v.videoId];
      if (rawUpload && rawUpload.trim()) {
        try {
          const parsedWords = parseTranscriptInput(rawUpload);
          return {
            ...v,
            transcriptWords: parsedWords,
            transcriptText: parsedWords.map((w) => w.word).join(' '),
            transcriptSource: 'USER_UPLOAD',
          };
        } catch {
          return {
            ...v,
            transcriptText: rawUpload.trim(),
            transcriptSource: 'USER_UPLOAD',
          };
        }
      }
      return v;
    });
  };

  // Path (iii): Explicit manual videos provided
  if (Array.isArray(manualVideos) && manualVideos.length > 0) {
    const hydrated: YouTubeVideoMeta[] = manualVideos.map((m, idx) => {
      const videoId = String(m.videoId || `vid-manual-${idx + 1}`).trim();
      let words = m.transcriptWords;
      let text = m.transcriptText;
      let source = m.transcriptSource ?? 'UNKNOWN';

      if (!words && text && (text.includes('-->') || text.trim().startsWith('['))) {
        try {
          words = parseTranscriptInput(text);
          text = words.map((w: { word: string }) => w.word).join(' ');
          source = 'CAPTIONS';
        } catch {
          // Keep plain transcriptText
        }
      } else if (words && words.length > 0 && !text) {
        text = words.map((w: { word: string }) => w.word).join(' ');
        source = 'CAPTIONS';
      } else if (text && text.trim().length > 0 && source === 'UNKNOWN') {
        source = 'CAPTIONS';
      }

      return {
        videoId,
        title: String(m.title || `Video ${idx + 1}`).trim(),
        description: String(m.description || '').trim(),
        publishedAt: m.publishedAt || new Date(Date.now() - idx * 86_400_000 * 7).toISOString(),
        views: Number(m.views ?? 1000),
        durationSec: m.durationSec ? Number(m.durationSec) : undefined,
        channelId: m.channelId || 'UC_MANUAL',
        channelTitle: m.channelTitle || (channelInput.trim() || 'Manual Channel'),
        transcriptText: text,
        transcriptWords: words,
        transcriptSource: source,
      };
    });

    const withUploads = attachUploadedTranscripts(hydrated);
    for (const v of withUploads) {
      db.prepare(
        `INSERT INTO channel_videos (project_id, video_id, meta_json, transcript_json, fetched_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(project_id, video_id) DO UPDATE SET
           meta_json = excluded.meta_json,
           transcript_json = COALESCE(excluded.transcript_json, channel_videos.transcript_json),
           fetched_at = CURRENT_TIMESTAMP`
      ).run(
        projectId,
        v.videoId,
        JSON.stringify(v),
        v.transcriptWords
          ? JSON.stringify(v.transcriptWords)
          : v.transcriptText
            ? JSON.stringify({ text: v.transcriptText })
            : null
      );
    }

    return {
      channelId: withUploads[0]?.channelId || 'UC_MANUAL',
      channelTitle: withUploads[0]?.channelTitle || 'Manual Channel',
      videos: withUploads,
    };
  }

  const parsedId = parseChannelIdentifier(channelInput);
  if (parsedId.kind === 'UNKNOWN' || !parsedId.value) {
    throw createYouTubeError(
      'CHANNEL_NOT_FOUND',
      `Could not parse a valid YouTube channel ID, @handle, or video URL list from "${channelInput}".`,
      404
    );
  }

  // Check SQLite 24h cache first if we have cached videos for this project
  const cachedRows = db
    .prepare(
      `SELECT video_id, meta_json, transcript_json, fetched_at
       FROM channel_videos WHERE project_id = ?`
    )
    .all(projectId) as Array<{
    video_id: string;
    meta_json: string;
    transcript_json: string | null;
    fetched_at: string;
  }>;

  if (cachedRows.length >= CHANNEL_MIN_PUBLIC_VIDEOS) {
    const newestFetch = Math.max(...cachedRows.map((r) => Date.parse(r.fetched_at || '1970-01-01')));
    if (Number.isFinite(newestFetch) && Date.now() - newestFetch < CHANNEL_CACHE_TTL_MS) {
      const cachedVideos = cachedRows
        .map((r) => {
          try {
            return JSON.parse(r.meta_json) as YouTubeVideoMeta;
          } catch {
            return null;
          }
        })
        .filter((v): v is YouTubeVideoMeta => v !== null);

      if (
        cachedVideos.length >= CHANNEL_MIN_PUBLIC_VIDEOS &&
        cachedVideos[0]?.channelId === parsedId.value
      ) {
        return {
          channelId: cachedVideos[0].channelId || parsedId.value,
          channelTitle: cachedVideos[0].channelTitle || parsedId.value,
          videos: attachUploadedTranscripts(cachedVideos),
        };
      }
    }
  }

  // Path (i): Optional YouTube Data API v3 key in Vault
  const ytKeys = getActiveDecryptedKeys(db, 'YOUTUBE');
  let resolvedChannelId = parsedId.kind === 'CHANNEL_ID' ? parsedId.value : '';

  if (ytKeys.length > 0 && parsedId.kind === 'HANDLE') {
    const ytKey = ytKeys[0].apiKey;
    const handleClean = parsedId.value.replace(/^@/, '');
    const handleUrl = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(
      handleClean
    )}&key=${encodeURIComponent(ytKey)}`;
    const res = await customFetch(handleUrl);
    if (res.status === 429) {
      throw createYouTubeError('YOUTUBE_QUOTA', 'YouTube Data API v3 quota exceeded.', 429);
    }
    if (res.ok) {
      const data = (await res.json()) as { items?: Array<{ id?: string }> };
      if (data.items?.[0]?.id) {
        resolvedChannelId = data.items[0].id;
      }
    }
  }

  // If still a handle, resolve channel_id from channel page HTML or RSS
  if (!resolvedChannelId && parsedId.kind === 'HANDLE') {
    const pageUrl = `https://www.youtube.com/${encodeURIComponent(parsedId.value)}`;
    const pageRes = await customFetch(pageUrl);
    if (pageRes.status === 404) {
      throw createYouTubeError(
        'CHANNEL_NOT_FOUND',
        `YouTube handle "${parsedId.value}" was not found.`,
        404
      );
    }
    if (pageRes.status === 403) {
      throw createYouTubeError(
        'CHANNEL_PRIVATE',
        `YouTube channel "${parsedId.value}" is private or restricted.`,
        403
      );
    }
    const html = await pageRes.text();
    if (html.includes('<feed') && html.includes('<entry>')) {
      const parsedFeed = parseYouTubeRssXml(html);
      return {
        channelId: parsedFeed.channelId,
        channelTitle: parsedFeed.channelTitle,
        videos: attachUploadedTranscripts(parsedFeed.videos),
      };
    }
    const cidMatch =
      html.match(/channel_id=(UC[0-9A-Za-z_-]{20,24})/) ||
      html.match(/"externalId":"(UC[0-9A-Za-z_-]{20,24})"/);
    if (!cidMatch) {
      throw createYouTubeError(
        'CHANNEL_NOT_FOUND',
        `Could not resolve channel ID for "${parsedId.value}". Paste the UC... channel ID or 5-10 video URLs.`,
        404
      );
    }
    resolvedChannelId = cidMatch[1];
  }

  // Path (ii): Public RSS feed
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(
    resolvedChannelId || parsedId.value
  )}`;
  const rssRes = await customFetch(rssUrl);
  if (rssRes.status === 404) {
    throw createYouTubeError(
      'CHANNEL_NOT_FOUND',
      `Channel "${resolvedChannelId || parsedId.value}" not found on YouTube RSS.`,
      404
    );
  }
  if (rssRes.status === 403) {
    throw createYouTubeError(
      'CHANNEL_PRIVATE',
      `Channel "${resolvedChannelId || parsedId.value}" is private.`,
      403
    );
  }
  if (rssRes.status === 429) {
    throw createYouTubeError('YOUTUBE_QUOTA', 'YouTube rate limit reached.', 429);
  }

  const xmlText = await rssRes.text();
  const parsedFeed = parseYouTubeRssXml(xmlText);
  const withUploads = attachUploadedTranscripts(parsedFeed.videos);

  for (const v of withUploads) {
    db.prepare(
      `INSERT INTO channel_videos (project_id, video_id, meta_json, transcript_json, fetched_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(project_id, video_id) DO UPDATE SET
         meta_json = excluded.meta_json,
         transcript_json = COALESCE(excluded.transcript_json, channel_videos.transcript_json),
         fetched_at = CURRENT_TIMESTAMP`
    ).run(
      projectId,
      v.videoId,
      JSON.stringify(v),
      v.transcriptWords ? JSON.stringify(v.transcriptWords) : null
    );
  }

  return {
    channelId: parsedFeed.channelId,
    channelTitle: parsedFeed.channelTitle,
    videos: withUploads,
  };
}

export interface ThumbnailVisionResult {
  videoId: string;
  bytesHash: string;
  composition: string;
  facePresent: boolean;
  faceExpression: string;
  dominantColors: string[];
  textOverlayOcr: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export async function inspectThumbnailVision(params: {
  db: DatabaseSync;
  gemini: { generateStructured: (req: any) => Promise<any> };
  videoId: string;
  thumbnailUrl?: string;
  mockFetch?: typeof fetch;
}): Promise<ThumbnailVisionResult> {
  const { db, gemini, videoId, thumbnailUrl, mockFetch } = params;
  const fetchImpl = mockFetch || fetch;

  const resolvedUrl =
    thumbnailUrl || `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;

  try {
    const res = await fetchImpl(resolvedUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return {
        videoId,
        bytesHash: 'UNKNOWN',
        composition: 'UNKNOWN',
        facePresent: false,
        faceExpression: 'UNKNOWN',
        dominantColors: [],
        textOverlayOcr: '',
        confidence: 'LOW',
      };
    }

    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    const cacheRow = db
      .prepare(`SELECT specs_json FROM thumbnail_vision_cache WHERE hash = ?`)
      .get(hash) as { specs_json: string } | undefined;

    if (cacheRow) {
      return JSON.parse(cacheRow.specs_json) as ThumbnailVisionResult;
    }

    const base64 = buf.toString('base64');
    const visionRes = (await gemini.generateStructured({
      db,
      stage: 'THUMBNAIL_VISION',
      tier: 'TIER_FAST',
      systemInstruction:
        'You are the ShowRunner Thumbnail Vision Inspector. Inspect this YouTube thumbnail and extract visual specifications.',
      userPrompt: `Analyze this thumbnail image for videoId "${videoId}". Extract composition, face expression, dominant palette, and text overlay OCR.`,
      responseSchema: {
        type: 'OBJECT' as any,
        properties: {
          composition: { type: 'STRING' as any },
          facePresent: { type: 'BOOLEAN' as any },
          faceExpression: { type: 'STRING' as any },
          dominantColors: { type: 'ARRAY' as any, items: { type: 'STRING' as any } },
          textOverlayOcr: { type: 'STRING' as any },
          confidence: { type: 'STRING' as any },
        },
        required: [
          'composition',
          'facePresent',
          'faceExpression',
          'dominantColors',
          'textOverlayOcr',
          'confidence',
        ],
      },
      inlineData: {
        mimeType: 'image/jpeg',
        data: base64,
      },
    })) as {
      data: {
        composition: string;
        facePresent: boolean;
        faceExpression: string;
        dominantColors: string[];
        textOverlayOcr: string;
        confidence: 'HIGH' | 'MEDIUM' | 'LOW';
      };
    };

    const result: ThumbnailVisionResult = {
      videoId,
      bytesHash: hash,
      composition: visionRes.data.composition || 'UNKNOWN',
      facePresent: Boolean(visionRes.data.facePresent),
      faceExpression: visionRes.data.faceExpression || 'UNKNOWN',
      dominantColors: visionRes.data.dominantColors || [],
      textOverlayOcr: visionRes.data.textOverlayOcr || '',
      confidence: visionRes.data.confidence || 'MEDIUM',
    };

    db.prepare(
      `INSERT OR REPLACE INTO thumbnail_vision_cache (hash, video_id, specs_json)
       VALUES (?, ?, ?)`
    ).run(hash, videoId, JSON.stringify(result));

    return result;
  } catch (_err) {
    return {
      videoId,
      bytesHash: 'UNKNOWN',
      composition: 'UNKNOWN',
      facePresent: false,
      faceExpression: 'UNKNOWN',
      dominantColors: [],
      textOverlayOcr: '',
      confidence: 'LOW',
    };
  }
}
