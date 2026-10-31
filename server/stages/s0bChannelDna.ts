import { Type, type Schema } from '@google/genai';
import type { DatabaseSync } from 'node:sqlite';
import {
   computeFidelityWeights,
  DEFAULT_DNA_FIDELITY,
  DEFAULT_WPM,
  FORMAT_PRESETS,
  MAX_TITLE_CHARS,
  SENTENCE_WORDS_MAX,
  SENTENCE_WORDS_MIN,
  WORDS_PER_PARAGRAPH_TARGET,
  type ChannelAnalysisDepth,
  type NarrativeFormatPresetId,
} from '../../src/config/constants.ts';
import { assertSupportedLanguageScript } from '../../shared/rules/hindiNumbers.ts';
import { computePayloadHash } from '../db/db.ts';
import { markDownstreamStagesDirty } from '../fsm/invalidation.ts';
import { commitStageState } from '../fsm/machine.ts';
import type { GeminiGateway } from '../llm/gemini.ts';
import {
  computeDeterministicVideoStats,
  fetchChannelVideosWithCache,
  filterClaimsRequiringEvidence,
  selectDeterministicChannelSample,
  type DeterministicChannelStats,
  type EvidenceBackedClaim,
  type SampledChannelVideo,
  type YouTubeVideoMeta,
} from '../youtube/client.ts';

export type ChannelDnaSource = 'ANALYSED' | 'NICHE' | 'HYBRID' | 'EXPRESS';
export type ChannelDnaRecord = ChannelDNA;

export interface ChannelDNA {
  version: number;
  lockedAt: string;
  source: ChannelDnaSource;
  fidelity: number;
  identity: {
    niche: string;
    subNiche: string;
    pillars: string[];
    audiencePersona: string;
    valueProp: string;
    differentiator: string;
  };
  language: {
    primary: string;
    script: string;
    codeSwitchRatio: number;
    formality: number;
  };
  voice: {
    persona: string;
    toneAxes: {
      seriousPlayful: number;
      fastSlow: number;
      simpleTechnical: number;
      warmCold: number;
    };
    wpm: number | null;
    sentenceLen: [number, number];
    paragraphWords: number;
    catchphrases: string[];
    bannedWords: string[];
    mustUsePhrases: string[];
  };
  structure: {
    formatPreset: 'DOCUMENTARY' | 'EXPLAINER' | 'STORYTIME' | 'LISTICLE' | 'CUSTOM';
    chapters: Array<{ name: string; sharePct: number }>;
    hookStyle: string;
    hookSeconds: number;
    reengageEverySec: [number, number];
    ctaStyle: string;
    durationRangeMin: [number, number];
  };
  packaging: {
    titleFormulas: string[];
    titleCharMax: number;
    overlayRules: {
      maxWords: number;
      style: string;
    };
    thumbnailStyle: {
      composition: string;
      palette: string[];
      faceUsage: string;
      textPlacement: string;
    };
  };
  visuals: {
    style: string;
    stylePrefix?: string;
    palette: string[];
    lighting: string[];
    cameraMotion: string[];
    negativePrompts: string[];
  };
  pacing: {
    cutDurationSec: [number, number];
    brollDensity: string;
  };
  performanceInsights: {
    outliers: Array<{ videoId: string; title: string; ratio: number; whyItWorked: string }>;
    doMore: string[];
    avoid: string[];
  };
  confidence: Record<string, 'HIGH' | 'MEDIUM' | 'LOW'>;
  evidence: Array<{ field: string; videoId: string; quoteOrTimestamp: string }>;
  referenceTitles?: string[];
  referenceHooks?: string[];
  pacingAndMetrics?: {
    wpm: number;
    sentenceLengthMin: number;
    sentenceLengthMax: number;
    targetDurationMin: number;
    preferredCutRangeSec: [number, number];
  };
  visualDirection?: {
    aesthetic: string;
    palette: string[];
    stylePrefix?: string;
    lighting?: string[];
    negativePrompts?: string[];
  };
}

export interface NicheQuestionnaireInput {
  niche: string;
  subNiche?: string;
  targetAudience?: string;
  language?: string;
  script?: string;
  formatPreset?: NarrativeFormatPresetId;
  tonePreferences?: string;
  targetLengthMin?: [number, number];
  uploadCadence?: string;
  goal?: string;
}

export interface NicheStyleOption {
  optionId: string;
  label: string;
  tagline: string;
  whyItWins: string;
  dna: ChannelDNA;
}

export interface NicheIntelligenceReport {
  niche: string;
  groundedMarkdown: string;
  webSearchQueries: string[];
  topPatterns: string[];
  contentGaps: string[];
  audiencePainPoints: string[];
  styleOptions: [NicheStyleOption, NicheStyleOption, NicheStyleOption];
}

interface LlmChannelQualitativeInference {
  identity: {
    niche: string;
    subNiche: string;
    pillars: string[];
    audiencePersona: string;
    valueProp: string;
    differentiator: string;
  };
  language: {
    primary: string;
    script: string;
    codeSwitchRatio: number;
    formality: number;
  };
  voice: {
    persona: string;
    toneAxes: {
      seriousPlayful: number;
      fastSlow: number;
      simpleTechnical: number;
      warmCold: number;
    };
    catchphrases: string[];
    bannedWords: string[];
    mustUsePhrases: string[];
  };
  structure: {
    formatPreset: 'DOCUMENTARY' | 'EXPLAINER' | 'STORYTIME' | 'LISTICLE' | 'CUSTOM';
    hookStyle: string;
    hookSeconds: number;
    ctaStyle: string;
  };
  packaging: {
    titleFormulas: string[];
    overlayStyle: string;
    thumbnailComposition: string;
    thumbnailPalette: string[];
    faceUsage: string;
  };
  visuals: {
    style: string;
    palette: string[];
    lighting: string[];
    cameraMotion: string[];
    negativePrompts: string[];
  };
  pacing: {
    cutDurationSec: number[];
    brollDensity: string;
  };
  outlierReasons: Array<{
    videoId: string;
    whyItWorked: string;
    evidenceQuoteOrTimestamp: string;
  }>;
  claims: Array<{
    field: string;
    claim: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    evidence: Array<{ videoId: string; quoteOrTimestamp: string }>;
  }>;
}

const CHANNEL_QUALITATIVE_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: [
    'identity',
    'language',
    'voice',
    'structure',
    'packaging',
    'visuals',
    'pacing',
    'outlierReasons',
    'claims',
  ],
  properties: {
    identity: {
      type: Type.OBJECT,
      required: ['niche', 'subNiche', 'pillars', 'audiencePersona', 'valueProp', 'differentiator'],
      properties: {
        niche: { type: Type.STRING },
        subNiche: { type: Type.STRING },
        pillars: { type: Type.ARRAY, items: { type: Type.STRING } },
        audiencePersona: { type: Type.STRING },
        valueProp: { type: Type.STRING },
        differentiator: { type: Type.STRING },
      },
    },
    language: {
      type: Type.OBJECT,
      required: ['primary', 'script', 'codeSwitchRatio', 'formality'],
      properties: {
        primary: { type: Type.STRING },
        script: { type: Type.STRING },
        codeSwitchRatio: { type: Type.NUMBER },
        formality: { type: Type.NUMBER },
      },
    },
    voice: {
      type: Type.OBJECT,
      required: ['persona', 'toneAxes', 'catchphrases', 'bannedWords', 'mustUsePhrases'],
      properties: {
        persona: { type: Type.STRING },
        toneAxes: {
          type: Type.OBJECT,
          required: ['seriousPlayful', 'fastSlow', 'simpleTechnical', 'warmCold'],
          properties: {
            seriousPlayful: { type: Type.NUMBER },
            fastSlow: { type: Type.NUMBER },
            simpleTechnical: { type: Type.NUMBER },
            warmCold: { type: Type.NUMBER },
          },
        },
        catchphrases: { type: Type.ARRAY, items: { type: Type.STRING } },
        bannedWords: { type: Type.ARRAY, items: { type: Type.STRING } },
        mustUsePhrases: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
    structure: {
      type: Type.OBJECT,
      required: ['formatPreset', 'hookStyle', 'hookSeconds', 'ctaStyle'],
      properties: {
        formatPreset: { type: Type.STRING },
        hookStyle: { type: Type.STRING },
        hookSeconds: { type: Type.NUMBER },
        ctaStyle: { type: Type.STRING },
      },
    },
    packaging: {
      type: Type.OBJECT,
      required: [
        'titleFormulas',
        'overlayStyle',
        'thumbnailComposition',
        'thumbnailPalette',
        'faceUsage',
      ],
      properties: {
        titleFormulas: { type: Type.ARRAY, items: { type: Type.STRING } },
        overlayStyle: { type: Type.STRING },
        thumbnailComposition: { type: Type.STRING },
        thumbnailPalette: { type: Type.ARRAY, items: { type: Type.STRING } },
        faceUsage: { type: Type.STRING },
      },
    },
    visuals: {
      type: Type.OBJECT,
      required: ['style', 'palette', 'lighting', 'cameraMotion', 'negativePrompts'],
      properties: {
        style: { type: Type.STRING },
        palette: { type: Type.ARRAY, items: { type: Type.STRING } },
        lighting: { type: Type.ARRAY, items: { type: Type.STRING } },
        cameraMotion: { type: Type.ARRAY, items: { type: Type.STRING } },
        negativePrompts: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
    pacing: {
      type: Type.OBJECT,
      required: ['cutDurationSec', 'brollDensity'],
      properties: {
        cutDurationSec: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        brollDensity: { type: Type.STRING },
      },
    },
    outlierReasons: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ['videoId', 'whyItWorked', 'evidenceQuoteOrTimestamp'],
        properties: {
          videoId: { type: Type.STRING },
          whyItWorked: { type: Type.STRING },
          evidenceQuoteOrTimestamp: { type: Type.STRING },
        },
      },
    },
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ['field', 'claim', 'confidence', 'evidence'],
        properties: {
          field: { type: Type.STRING },
          claim: { type: Type.STRING },
          confidence: { type: Type.STRING },
          evidence: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ['videoId', 'quoteOrTimestamp'],
              properties: {
                videoId: { type: Type.STRING },
                quoteOrTimestamp: { type: Type.STRING },
              },
            },
          },
        },
      },
    },
  },
};

const NICHE_SYNTHESIS_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: ['topPatterns', 'contentGaps', 'audiencePainPoints', 'options'],
  properties: {
    topPatterns: { type: Type.ARRAY, items: { type: Type.STRING } },
    contentGaps: { type: Type.ARRAY, items: { type: Type.STRING } },
    audiencePainPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
    options: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          'optionId',
          'label',
          'tagline',
          'whyItWins',
          'persona',
          'formatPreset',
          'hookStyle',
          'titleFormulas',
          'visualStyle',
          'palette',
          'lighting',
          'pillars',
          'differentiator',
        ],
        properties: {
          optionId: { type: Type.STRING },
          label: { type: Type.STRING },
          tagline: { type: Type.STRING },
          whyItWins: { type: Type.STRING },
          persona: { type: Type.STRING },
          formatPreset: { type: Type.STRING },
          hookStyle: { type: Type.STRING },
          titleFormulas: { type: Type.ARRAY, items: { type: Type.STRING } },
          visualStyle: { type: Type.STRING },
          palette: { type: Type.ARRAY, items: { type: Type.STRING } },
          lighting: { type: Type.ARRAY, items: { type: Type.STRING } },
          pillars: { type: Type.ARRAY, items: { type: Type.STRING } },
          differentiator: { type: Type.STRING },
        },
      },
    },
  },
};

function normaliseChaptersForPreset(
  preset: string,
  customChapters?: ReadonlyArray<{ name: string; sharePct: number }>
): Array<{ name: string; sharePct: number }> {
  if (Array.isArray(customChapters) && customChapters.length > 0) {
    const sum = customChapters.reduce((acc, c) => acc + (Number(c.sharePct) || 0), 0);
    if (sum > 0) {
      let running = 0;
      return customChapters.map((c, idx) => {
        const isLast = idx === customChapters.length - 1;
        const pct = isLast
          ? Math.max(1, 100 - running)
          : Math.max(1, Math.round(((Number(c.sharePct) || 10) / sum) * 100));
        running += pct;
        return { name: String(c.name || `Chapter ${idx + 1}`).trim(), sharePct: pct };
      });
    }
  }
  const key = (
    ['DOCUMENTARY', 'EXPLAINER', 'STORYTIME', 'LISTICLE'].includes(String(preset).toUpperCase())
      ? String(preset).toUpperCase()
      : 'DOCUMENTARY'
  ) as NarrativeFormatPresetId;
  return FORMAT_PRESETS[key].map((p) => ({ name: p.name, sharePct: p.sharePct }));
}

export function normalizeChannelDnaObject(
  partial: Partial<ChannelDNA>,
  defaults?: {
    version?: number;
    source?: ChannelDnaSource;
    niche?: string;
    script?: string;
    primaryLang?: string;
  }
): ChannelDNA {
  const rawScript =
    partial.language?.script || defaults?.script || 'Devanagari';
  const canonicalScript = assertSupportedLanguageScript(rawScript);
  const primaryLang =
    partial.language?.primary ||
    defaults?.primaryLang ||
    (canonicalScript === 'Latin' ? 'en' : 'hi');

  const formatPreset = (
    ['DOCUMENTARY', 'EXPLAINER', 'STORYTIME', 'LISTICLE', 'CUSTOM'].includes(
      String(partial.structure?.formatPreset || '').toUpperCase()
    )
      ? String(partial.structure?.formatPreset).toUpperCase()
      : 'DOCUMENTARY'
  ) as ChannelDNA['structure']['formatPreset'];

  const chapters = normaliseChaptersForPreset(
    formatPreset,
    partial.structure?.chapters
  );

  const sMin = Number(partial.voice?.sentenceLen?.[0] ?? SENTENCE_WORDS_MIN);
  const sMax = Number(partial.voice?.sentenceLen?.[1] ?? SENTENCE_WORDS_MAX);

  return {
    version: Number(partial.version ?? defaults?.version ?? 1),
    lockedAt: partial.lockedAt || new Date().toISOString(),
    source: partial.source || defaults?.source || 'NICHE',
    fidelity: Math.max(
      0,
      Math.min(100, Number(partial.fidelity ?? DEFAULT_DNA_FIDELITY))
    ),
    identity: {
      niche: partial.identity?.niche || defaults?.niche || 'General Creator Channel',
      subNiche: partial.identity?.subNiche || 'High-Retention Deep Dives',
      pillars:
        Array.isArray(partial.identity?.pillars) && partial.identity.pillars.length > 0
          ? partial.identity.pillars.map(String)
          : ['Core Mechanism Breakdown', 'Counter-Intuitive Case Studies', 'Actionable Synthesis'],
      audiencePersona:
        partial.identity?.audiencePersona ||
        'Curious viewers seeking clear, evidence-backed explanations without fluff',
      valueProp:
        partial.identity?.valueProp ||
        'High-density, evidence-grounded storytelling with zero filler',
      differentiator:
        partial.identity?.differentiator ||
        'Primary-source evidence paired with cinematic visual metaphors',
    },
    language: {
      primary: primaryLang,
      script: canonicalScript,
      codeSwitchRatio: Number(partial.language?.codeSwitchRatio ?? 0.15),
      formality: Number(partial.language?.formality ?? 0.65),
    },
    voice: {
      persona:
        partial.voice?.persona ||
        'Authoritative, investigative narrator with sharp pacing and zero clichés',
      toneAxes: {
        seriousPlayful: Number(partial.voice?.toneAxes?.seriousPlayful ?? 0.25),
        fastSlow: Number(partial.voice?.toneAxes?.fastSlow ?? 0.65),
        simpleTechnical: Number(partial.voice?.toneAxes?.simpleTechnical ?? 0.6),
        warmCold: Number(partial.voice?.toneAxes?.warmCold ?? 0.45),
      },
      wpm:
        partial.voice?.wpm === null
          ? null
          : Number.isFinite(Number(partial.voice?.wpm))
            ? Number(partial.voice?.wpm)
            : DEFAULT_WPM,
      sentenceLen: [
        Math.max(4, Math.min(sMin, sMax)),
        Math.max(sMin + 2, sMax),
      ],
      paragraphWords: Number(
        partial.voice?.paragraphWords ?? WORDS_PER_PARAGRAPH_TARGET
      ),
      catchphrases: Array.isArray(partial.voice?.catchphrases)
        ? partial.voice.catchphrases.map(String)
        : [],
      bannedWords: Array.isArray(partial.voice?.bannedWords)
        ? partial.voice.bannedWords.map(String)
        : [],
      mustUsePhrases: Array.isArray(partial.voice?.mustUsePhrases)
        ? partial.voice.mustUsePhrases.map(String)
        : [],
    },
    structure: {
      formatPreset,
      chapters,
      hookStyle:
        partial.structure?.hookStyle ||
        'Counter-intuitive anomaly statement followed by a 15-30s causal pivot',
      hookSeconds: Number(partial.structure?.hookSeconds ?? 15),
      reengageEverySec: [
        Number(partial.structure?.reengageEverySec?.[0] ?? 60),
        Number(partial.structure?.reengageEverySec?.[1] ?? 90),
      ],
      ctaStyle:
        partial.structure?.ctaStyle ||
        'Final synthesis payoff tied to the opening anomaly',
      durationRangeMin: [
        Number(partial.structure?.durationRangeMin?.[0] ?? 8),
        Number(partial.structure?.durationRangeMin?.[1] ?? 14),
      ],
    },
    packaging: {
      titleFormulas:
        Array.isArray(partial.packaging?.titleFormulas) &&
        partial.packaging.titleFormulas.length > 0
          ? partial.packaging.titleFormulas.map(String)
          : [
              'Why [Specific Entity] Actually [Unexpected Outcome]',
              'The [Number] Second Rule Behind [Phenomenon]',
              'How [Subject] Quietly Changed [Domain]',
            ],
      titleCharMax: Math.min(
        MAX_TITLE_CHARS,
        Math.max(25, Number(partial.packaging?.titleCharMax ?? MAX_TITLE_CHARS))
      ),
      overlayRules: {
        maxWords: Number(partial.packaging?.overlayRules?.maxWords ?? 4),
        style:
          partial.packaging?.overlayRules?.style ||
          'Zero word overlap with title; high-contrast 2-4 word tension hook',
      },
      thumbnailStyle: {
        composition:
          partial.packaging?.thumbnailStyle?.composition ||
          'Rule-of-thirds focal subject with bottom-right 20% timestamp safe zone clear',
        palette:
          Array.isArray(partial.packaging?.thumbnailStyle?.palette) &&
          partial.packaging.thumbnailStyle.palette.length > 0
            ? partial.packaging.thumbnailStyle.palette.map(String)
            : ['#090A0F', '#00F0FF', '#F4F4F6'],
        faceUsage:
          partial.packaging?.thumbnailStyle?.faceUsage ||
          'Expressive anatomical micro-tension or high-contrast focal object',
        textPlacement:
          partial.packaging?.thumbnailStyle?.textPlacement ||
          'Upper-left or center-left bold overlay away from bottom-right 20%',
      },
    },
    visuals: {
      style:
        partial.visuals?.style ||
        '16:9 widescreen high-contrast cinematic realism with controlled depth of field',
      palette:
        Array.isArray(partial.visuals?.palette) && partial.visuals.palette.length > 0
          ? partial.visuals.palette.map(String)
          : ['Deep obsidian', 'Electric cyan', 'Warm tungsten key'],
      lighting:
        Array.isArray(partial.visuals?.lighting) && partial.visuals.lighting.length > 0
          ? partial.visuals.lighting.map(String)
          : ['Chiaroscuro key lighting with subtle cyan and violet rim highlights'],
      cameraMotion:
        Array.isArray(partial.visuals?.cameraMotion) && partial.visuals.cameraMotion.length > 0
          ? partial.visuals.cameraMotion.map(String)
          : ['35mm slow dolly-in', '50mm lateral parallax slide'],
      negativePrompts: Array.isArray(partial.visuals?.negativePrompts)
        ? partial.visuals.negativePrompts.map(String)
        : [],
    },
    pacing: {
      cutDurationSec: [
        Number(partial.pacing?.cutDurationSec?.[0] ?? 4.5),
        Number(partial.pacing?.cutDurationSec?.[1] ?? 7.8),
      ],
      brollDensity: partial.pacing?.brollDensity || 'High visual change every sentence',
    },
    performanceInsights: {
      outliers: Array.isArray(partial.performanceInsights?.outliers)
        ? partial.performanceInsights.outliers
        : [],
      doMore: Array.isArray(partial.performanceInsights?.doMore)
        ? partial.performanceInsights.doMore.map(String)
        : ['Anchor every claim with a concrete number or primary source'],
      avoid: Array.isArray(partial.performanceInsights?.avoid)
        ? partial.performanceInsights.avoid.map(String)
        : ['Slow generic introductions without an immediate anomaly'],
    },
    confidence: partial.confidence ?? {
      identity: 'HIGH',
      language: 'HIGH',
      'voice.wpm': partial.voice?.wpm ? 'HIGH' : 'LOW',
      structure: 'HIGH',
      packaging: 'HIGH',
      visuals: 'HIGH',
    },
    evidence: Array.isArray(partial.evidence) ? partial.evidence : [],
    referenceTitles: Array.isArray(partial.referenceTitles)
      ? partial.referenceTitles
      : undefined,
    referenceHooks: Array.isArray(partial.referenceHooks)
      ? partial.referenceHooks
      : undefined,
    pacingAndMetrics: {
      wpm: Number.isFinite(Number(partial.voice?.wpm))
        ? Number(partial.voice?.wpm)
        : DEFAULT_WPM,
      sentenceLengthMin: Math.max(4, Math.min(sMin, sMax)),
      sentenceLengthMax: Math.max(sMin + 2, sMax),
      targetDurationMin: 11,
      preferredCutRangeSec: [
        Number(partial.pacing?.cutDurationSec?.[0] ?? 4.5),
        Number(partial.pacing?.cutDurationSec?.[1] ?? 7.8),
      ],
    },
    visualDirection: {
      aesthetic:
        partial.visuals?.style ||
        '16:9 widescreen high-contrast cinematic realism with controlled depth of field',
      palette:
        Array.isArray(partial.visuals?.palette) && partial.visuals.palette.length > 0
          ? partial.visuals.palette.map(String)
          : ['Deep obsidian', 'Electric cyan', 'Warm tungsten key'],
      stylePrefix:
        (partial as any)?.visualDirection?.stylePrefix ||
        partial.visuals?.stylePrefix ||
        (partial as any)?.visual?.stylePrefix,
      lighting: partial.visuals?.lighting || (partial as any)?.visual?.lighting,
      negativePrompts: partial.visuals?.negativePrompts || (partial as any)?.visual?.negativePrompts || [],
    },
  };
}

/**
 * C2 Path A: Existing Channel Deep Analysis.
 * Computes all numeric statistics in code (`computeDeterministicVideoStats`),
 * infers qualitative layers via Gemini, and drops any qualitative claim lacking `evidence[]`.
 */
export async function handleAnalyseExistingChannelDna(params: {
  db: DatabaseSync;
  projectId: string;
  channelInput: string;
  depth?: ChannelAnalysisDepth;
  manualVideos?: ReadonlyArray<Partial<YouTubeVideoMeta>>;
  uploadedTranscripts?: Record<string, string>;
  gemini: GeminiGateway;
  customFetch?: typeof fetch;
  onProgress?: (pct: number, phase: string) => void;
}): Promise<{
  candidateDna: ChannelDNA;
  channelId: string;
  channelTitle: string;
  sampledVideos: SampledChannelVideo[];
  deterministicStats: DeterministicChannelStats;
  droppedClaimsCount: number;
}> {
  const {
    db,
    projectId,
    channelInput,
    depth = 'STANDARD',
    manualVideos,
    uploadedTranscripts,
    gemini,
    customFetch,
    onProgress,
  } = params;

  onProgress?.(10, 'Step 1/4: Discovering channel & fetching video catalog...');
  const fetched = await fetchChannelVideosWithCache({
    db,
    projectId,
    channelInput,
    manualVideos,
    uploadedTranscripts,
    customFetch,
  });

  onProgress?.(30, 'Step 2/4: Selecting deterministic outlier, median, lowest & newest sample...');
  const sampleSelection = selectDeterministicChannelSample(fetched.videos, depth);
  const deterministicStats = computeDeterministicVideoStats(sampleSelection.sampled);

  onProgress?.(55, 'Step 3/4: Running 8-layer qualitative analysis with evidence grounding...');
  const videoDigest = sampleSelection.sampled
    .map(
      (v, i) =>
        `[${i + 1}] videoId="${v.videoId}" | role=${v.sampleRole} | views=${v.views} (outlierRatio=${v.outlierRatio}x) | publishedAt=${v.publishedAt}\nTitle: ${v.title}\nDescription: ${v.description.slice(0, 260)}\nTranscriptSnippet: ${(v.transcriptText || 'NO_TRANSCRIPT_AVAILABLE').slice(0, 500)}`
    )
    .join('\n\n');

  const llmRes = await gemini.generateStructured<LlmChannelQualitativeInference>({
    db,
    projectId,
    stage: 'S0B_ANALYSE_CHANNEL',
    tier: 'TIER_REASONING',
    systemInstruction: `You are the Stage S0B Channel DNA Forensic Analyst.
Analyse the sampled videos from "${fetched.channelTitle}" (${fetched.channelId}).
CRITICAL RULES:
1. Every qualitative claim in "claims" MUST cite at least one real videoId from the sample and a concrete quote or timestamp.
2. Never invent numeric stats (code computes WPM, sentence lengths, and title lengths deterministically).`,
    userPrompt: `Sampled Videos (${sampleSelection.sampled.length}):\n${videoDigest}\n\nExtract the 8 qualitative DNA layers and evidence-backed claims strictly matching the JSON schema.`,
    responseSchema: CHANNEL_QUALITATIVE_SCHEMA,
    temperature: 0.2,
  });

  onProgress?.(85, 'Step 4/4: Filtering unverified claims & locking deterministic statistics...');
  const rawClaims = Array.isArray(llmRes.data.claims) ? llmRes.data.claims : [];
  const verifiedClaims = filterClaimsRequiringEvidence(
    rawClaims.map((c): EvidenceBackedClaim<string> & { field: string } => ({
      field: c.field,
      claim: c.claim,
      confidence: c.confidence,
      evidence: c.evidence,
    }))
  ) as Array<EvidenceBackedClaim<string> & { field: string }>;

  const droppedClaimsCount = Math.max(0, rawClaims.length - verifiedClaims.length);

  const flatEvidence: ChannelDNA['evidence'] = [];
  for (const vc of verifiedClaims) {
    for (const ev of vc.evidence) {
      flatEvidence.push({
        field: vc.field || 'voice',
        videoId: ev.videoId,
        quoteOrTimestamp: ev.quoteOrTimestamp,
      });
    }
  }

  // Merge deterministic stats over LLM qualitative layers (code always wins for numbers)
  const computedSentenceRange: [number, number] =
    deterministicStats.sentenceStats.hasTranscriptData &&
    deterministicStats.sentenceStats.p20Words !== null &&
    deterministicStats.sentenceStats.p80Words !== null
      ? [
          Math.max(5, deterministicStats.sentenceStats.p20Words),
          Math.max(
            deterministicStats.sentenceStats.p20Words + 3,
            deterministicStats.sentenceStats.p80Words
          ),
        ]
      : [SENTENCE_WORDS_MIN, SENTENCE_WORDS_MAX];

  const outliersList = sampleSelection.outliers.map((o) => {
    const reasonEntry = llmRes.data.outlierReasons?.find((r) => r.videoId === o.videoId);
    return {
      videoId: o.videoId,
      title: o.title,
      ratio: o.outlierRatio,
      whyItWorked:
        reasonEntry?.whyItWorked ||
        `Outperformed channel median by ${o.outlierRatio}x via high-curiosity title framing`,
    };
  });

  const confidenceMap: Record<string, 'HIGH' | 'MEDIUM' | 'LOW'> = {
    identity: 'HIGH',
    language: deterministicStats.sentenceStats.hasTranscriptData ? 'HIGH' : 'MEDIUM',
    'voice.wpm': deterministicStats.wpmStats.confidence,
    'voice.sentenceLen': deterministicStats.sentenceStats.hasTranscriptData ? 'HIGH' : 'LOW',
    structure: deterministicStats.sentenceStats.hasTranscriptData ? 'HIGH' : 'MEDIUM',
    packaging: 'HIGH',
    visuals: 'MEDIUM',
    pacing: 'MEDIUM',
  };

  const candidateDna = normalizeChannelDnaObject({
    version: 1,
    source: 'ANALYSED',
    fidelity: DEFAULT_DNA_FIDELITY,
    identity: llmRes.data.identity,
    language: llmRes.data.language,
    voice: {
      ...llmRes.data.voice,
      wpm: deterministicStats.wpmStats.measuredWpm, // null if no timed words!
      sentenceLen: computedSentenceRange,
      paragraphWords: WORDS_PER_PARAGRAPH_TARGET,
    },
    structure: {
      formatPreset: llmRes.data.structure.formatPreset,
      chapters: normaliseChaptersForPreset(llmRes.data.structure.formatPreset),
      hookStyle: llmRes.data.structure.hookStyle,
      hookSeconds: llmRes.data.structure.hookSeconds || 15,
      reengageEverySec: [60, 90],
      ctaStyle: llmRes.data.structure.ctaStyle,
      durationRangeMin: [8, 14],
    },
    packaging: {
      titleFormulas: llmRes.data.packaging.titleFormulas,
      titleCharMax: Math.min(
        MAX_TITLE_CHARS,
        Math.max(30, deterministicStats.titleStats.maxChars || MAX_TITLE_CHARS)
      ),
      overlayRules: {
        maxWords: 4,
        style: llmRes.data.packaging.overlayStyle,
      },
      thumbnailStyle: {
        composition: llmRes.data.packaging.thumbnailComposition,
        palette: llmRes.data.packaging.thumbnailPalette,
        faceUsage: llmRes.data.packaging.faceUsage,
        textPlacement: 'Upper-left bold text, bottom-right 20% clear',
      },
    },
    visuals: llmRes.data.visuals,
    pacing: {
      cutDurationSec: [
        Number(llmRes.data.pacing.cutDurationSec?.[0] ?? 4.5),
        Number(llmRes.data.pacing.cutDurationSec?.[1] ?? 7.8),
      ],
      brollDensity: llmRes.data.pacing.brollDensity,
    },
    performanceInsights: {
      outliers: outliersList,
      doMore: verifiedClaims.slice(0, 3).map((c) => c.claim),
      avoid: ['Generic slow intros without immediate curiosity gap'],
    },
    confidence: confidenceMap,
    evidence: flatEvidence,
  });

  onProgress?.(100, 'Channel DNA analysis complete.');
  return {
    candidateDna,
    channelId: fetched.channelId,
    channelTitle: fetched.channelTitle,
    sampledVideos: sampleSelection.sampled,
    deterministicStats,
    droppedClaimsCount,
  };
}

/**
 * C3 Path B: New Channel / Any Niche (2-step grounded Niche Intelligence:
 * Step 2A `googleSearch` markdown without schema -> Step 2B `responseSchema` without tools
 * producing 3 distinct Style Options).
 */
export async function handleAnalyseNicheDna(params: {
  db: DatabaseSync;
  projectId: string;
  input: NicheQuestionnaireInput;
  gemini: GeminiGateway;
  onProgress?: (pct: number, phase: string) => void;
}): Promise<NicheIntelligenceReport> {
  const { db, projectId, input, gemini, onProgress } = params;
  const niche = String(input.niche || '').trim();
  if (!niche) {
    const err = new Error('Channel niche is required for Niche Intelligence analysis.') as Error & {
      code?: string;
      statusCode?: number;
    };
    err.code = 'NICHE_REQUIRED';
    err.statusCode = 422;
    throw err;
  }

  const targetScript = assertSupportedLanguageScript(input.script || 'Devanagari');
  const primaryLang = input.language?.trim() || (targetScript === 'Latin' ? 'en' : 'hi');
  const defaultPreset: NarrativeFormatPresetId = input.formatPreset || 'DOCUMENTARY';

  onProgress?.(25, 'Step 1/2: Grounded Google Search on niche leaders, hooks & content gaps...');
  const step2A = await gemini.generateGroundedMarkdown({
    db,
    projectId,
    stage: 'S0B_NICHE_SEARCH',
    tier: 'TIER_REASONING',
    systemInstruction:
      'You are the ShowRunner OS Niche Intelligence Researcher. Use Google Search to research top-performing YouTube formats, title structures, thumbnail patterns, audience pain points, and underserved content gaps for the requested niche and language.',
    userPrompt: `Channel Niche: "${niche}"
Sub-Niche: "${input.subNiche || niche}"
Target Audience: "${input.targetAudience || 'Engaged YouTube viewers'}"
Primary Language: "${primaryLang}" (Script: "${targetScript}")
Preferred Format: "${defaultPreset}"
Tone Preferences: "${input.tonePreferences || 'Sharp, high-retention, authoritative'}"
Goal: "${input.goal || 'Audience growth & authority'}"

Produce a detailed markdown intelligence report covering winning title/thumbnail formulas, hook structures, pacing norms, and 3 distinct positioning directions.`,
    temperature: 0.2,
  });

  onProgress?.(65, 'Step 2/2: Synthesising 3 distinct Channel DNA Style Options...');
  const step2B = await gemini.generateStructured<{
    topPatterns: string[];
    contentGaps: string[];
    audiencePainPoints: string[];
    options: Array<{
      optionId: string;
      label: string;
      tagline: string;
      whyItWins: string;
      persona: string;
      formatPreset: string;
      hookStyle: string;
      titleFormulas: string[];
      visualStyle: string;
      palette: string[];
      lighting: string[];
      pillars: string[];
      differentiator: string;
    }>;
  }>({
    db,
    projectId,
    stage: 'S0B_NICHE_SYNTHESIS',
    tier: 'TIER_FAST',
    systemInstruction:
      'Convert the grounded Niche Intelligence dossier into 3 distinct, non-overlapping Channel DNA Style Options (e.g., Option A: Investigative/Forensic, Option B: Fast-Paced Visual Explainer, Option C: Narrative Case-Study Storyteller). Do NOT invoke tools.',
    userPrompt: `Grounded Niche Research:\n"""\n${step2A.markdown}\n"""\n\nReturn exactly 3 distinct Style Options matching the JSON schema.`,
    responseSchema: NICHE_SYNTHESIS_SCHEMA,
    temperature: 0.3,
  });

  const rawOptions = Array.isArray(step2B.data.options) ? step2B.data.options : [];
  const presetsFallback: NarrativeFormatPresetId[] = ['DOCUMENTARY', 'EXPLAINER', 'STORYTIME'];

  const builtOptions: NicheStyleOption[] = [0, 1, 2].map((idx) => {
    const raw = rawOptions[idx];
    const preset = (
      ['DOCUMENTARY', 'EXPLAINER', 'STORYTIME', 'LISTICLE'].includes(
        String(raw?.formatPreset || '').toUpperCase()
      )
        ? String(raw.formatPreset).toUpperCase()
        : presetsFallback[idx]
    ) as NarrativeFormatPresetId;

    const dna = normalizeChannelDnaObject(
      {
        version: 1,
        source: 'NICHE',
        fidelity: DEFAULT_DNA_FIDELITY,
        identity: {
          niche,
          subNiche: input.subNiche || niche,
          pillars: raw?.pillars?.length
            ? raw.pillars
            : [`${niche} Core Breakdowns`, `${niche} Case Studies`, `${niche} Myth vs Reality`],
          audiencePersona: input.targetAudience || `Viewers interested in ${niche}`,
          valueProp: raw?.tagline || `High-retention ${niche} insights`,
          differentiator:
            raw?.differentiator || `Distinct ${preset.toLowerCase()} angle on ${niche}`,
        },
        language: {
          primary: primaryLang,
          script: targetScript,
          codeSwitchRatio: targetScript === 'Devanagari' ? 0.15 : 0.0,
          formality: 0.65,
        },
        voice: {
          persona:
            raw?.persona ||
            `${niche} ${preset.toLowerCase()} narrator (${input.tonePreferences || 'sharp and clear'})`,
          toneAxes: {
            seriousPlayful: idx === 0 ? 0.2 : idx === 1 ? 0.45 : 0.35,
            fastSlow: idx === 1 ? 0.8 : 0.6,
            simpleTechnical: idx === 0 ? 0.7 : 0.5,
            warmCold: idx === 2 ? 0.3 : 0.5,
          },
          wpm: DEFAULT_WPM,
          sentenceLen: [SENTENCE_WORDS_MIN, SENTENCE_WORDS_MAX],
          paragraphWords: WORDS_PER_PARAGRAPH_TARGET,
          catchphrases: [],
          bannedWords: [],
          mustUsePhrases: [],
        },
        structure: {
          formatPreset: preset,
          chapters: normaliseChaptersForPreset(preset),
          hookStyle:
            raw?.hookStyle || 'Immediate counter-intuitive claim followed by causal pivot',
          hookSeconds: 15,
          reengageEverySec: [60, 90],
          ctaStyle: 'Payoff synthesis callback',
          durationRangeMin: input.targetLengthMin ?? [8, 12],
        },
        packaging: {
          titleFormulas: raw?.titleFormulas?.length
            ? raw.titleFormulas
            : [
                `Why [Specific ${niche} Concept] Changes Everything`,
                `The Truth About [${niche} Case Study]`,
                `How [${niche} Mechanism] Actually Works`,
              ],
          titleCharMax: MAX_TITLE_CHARS,
          overlayRules: {
            maxWords: 4,
            style: '2-4 bold contrast words with zero title overlap',
          },
          thumbnailStyle: {
            composition: 'High-contrast focal subject, bottom-right 20% clear',
            palette: raw?.palette?.length ? raw.palette : ['#0A0D14', '#00F0FF', '#FF3B5C'],
            faceUsage: 'Expressive reaction or crisp macro object',
            textPlacement: 'Top-left bold overlay',
          },
        },
        visuals: {
          style: raw?.visualStyle || '16:9 widescreen cinematic lighting and crisp visual metaphors',
          palette: raw?.palette?.length ? raw.palette : ['Obsidian', 'Cyan', 'Amber'],
          lighting: raw?.lighting?.length
            ? raw.lighting
            : ['High-contrast key lighting with volumetric rim'],
          cameraMotion: ['Slow motorized dolly-in', 'Controlled parallax slide'],
          negativePrompts: [],
        },
      },
      {
        version: 1,
        source: 'NICHE',
        niche,
        script: targetScript,
        primaryLang,
      }
    );

    return {
      optionId: raw?.optionId || `STYLE_${String.fromCharCode(65 + idx)}`,
      label: raw?.label || `Option ${String.fromCharCode(65 + idx)} — ${preset}`,
      tagline: raw?.tagline || `${niche} (${preset} Format)`,
      whyItWins:
        raw?.whyItWins ||
        `Capitalises on open content gaps in ${niche} using ${preset.toLowerCase()} pacing.`,
      dna,
    };
  });

  onProgress?.(100, 'Niche Intelligence & 3 Style Options ready.');
  return {
    niche,
    groundedMarkdown: step2A.markdown,
    webSearchQueries: step2A.webSearchQueries,
    topPatterns: step2B.data.topPatterns ?? [],
    contentGaps: step2B.data.contentGaps ?? [],
    audiencePainPoints: step2B.data.audiencePainPoints ?? [],
    styleOptions: [builtOptions[0], builtOptions[1], builtOptions[2]],
  };
}

/**
 * C4 Path C: Reference / Inspiration Channels (1-3 channels merged into HYBRID DNA + similarity guard references).
 */
export async function handleAnalyseReferenceChannelsDna(params: {
  db: DatabaseSync;
  projectId: string;
  channels: ReadonlyArray<{
    channelInput: string;
    manualVideos?: ReadonlyArray<Partial<YouTubeVideoMeta>>;
  }>;
  mixConfig?: {
    voiceFromIndex?: number;
    structureFromIndex?: number;
    visualsFromIndex?: number;
  };
  gemini: GeminiGateway;
  customFetch?: typeof fetch;
  onProgress?: (pct: number, phase: string) => void;
}): Promise<{
  candidateDna: ChannelDNA;
  analysedChannels: Array<{
    channelId: string;
    channelTitle: string;
    outlierCount: number;
  }>;
}> {
  const { db, projectId, channels, mixConfig, gemini, customFetch, onProgress } = params;
  const sliceChannels = channels.slice(0, 3);
  if (sliceChannels.length === 0) {
    const err = new Error('Provide 1 to 3 reference channels for Hybrid DNA analysis.') as Error & {
      code?: string;
      statusCode?: number;
    };
    err.code = 'CHANNEL_NOT_FOUND';
    err.statusCode = 422;
    throw err;
  }

  const perChannelResults: Array<Awaited<ReturnType<typeof handleAnalyseExistingChannelDna>>> = [];
  for (let i = 0; i < sliceChannels.length; i++) {
    const pct = Math.round(((i + 0.2) / sliceChannels.length) * 80);
    onProgress?.(pct, `Analysing reference channel ${i + 1}/${sliceChannels.length}...`);
    const res = await handleAnalyseExistingChannelDna({
      db,
      projectId,
      channelInput: sliceChannels[i].channelInput,
      manualVideos: sliceChannels[i].manualVideos,
      depth: 'QUICK',
      gemini,
      customFetch,
    });
    perChannelResults.push(res);
  }

  const voiceIdx = Math.min(
    perChannelResults.length - 1,
    Math.max(0, mixConfig?.voiceFromIndex ?? 0)
  );
  const structIdx = Math.min(
    perChannelResults.length - 1,
    Math.max(0, mixConfig?.structureFromIndex ?? (perChannelResults.length > 1 ? 1 : 0))
  );
  const visIdx = Math.min(
    perChannelResults.length - 1,
    Math.max(0, mixConfig?.visualsFromIndex ?? (perChannelResults.length > 2 ? 2 : 0))
  );

  const primaryDna = perChannelResults[0].candidateDna;
  const voiceDna = perChannelResults[voiceIdx].candidateDna;
  const structDna = perChannelResults[structIdx].candidateDna;
  const visDna = perChannelResults[visIdx].candidateDna;

  const allReferenceTitles = perChannelResults.flatMap((r) =>
    r.sampledVideos.map((v) => v.title)
  );
  const allReferenceHooks = perChannelResults.flatMap((r) =>
    r.sampledVideos
      .map((v) => (v.transcriptText || '').slice(0, 200).trim())
      .filter(Boolean)
  );

  const hybridDna = normalizeChannelDnaObject({
    ...primaryDna,
    source: 'HYBRID',
    voice: voiceDna.voice,
    structure: structDna.structure,
    visuals: visDna.visuals,
    packaging: structDna.packaging,
    performanceInsights: {
      outliers: perChannelResults.flatMap((r) => r.candidateDna.performanceInsights.outliers),
      doMore: perChannelResults.flatMap((r) => r.candidateDna.performanceInsights.doMore),
      avoid: perChannelResults.flatMap((r) => r.candidateDna.performanceInsights.avoid),
    },
    evidence: perChannelResults.flatMap((r) => r.candidateDna.evidence),
    referenceTitles: allReferenceTitles,
    referenceHooks: allReferenceHooks,
  });

  onProgress?.(100, 'Hybrid Reference Channel DNA synthesised.');
  return {
    candidateDna: hybridDna,
    analysedChannels: perChannelResults.map((r) => ({
      channelId: r.channelId,
      channelTitle: r.channelTitle,
      outlierCount: r.sampledVideos.filter((v) => v.sampleRole === 'OUTLIER').length,
    })),
  };
}

/**
 * Returns the currently locked ChannelDNA for `projectId`, or `null` if not locked yet.
 */
export function getLockedChannelDna(
  db: DatabaseSync,
  projectId: string
): { dna: ChannelDNA; hash: string; version: number; lockedAt: string } | null {
  const projRow = db
    .prepare(`SELECT dna_version FROM projects WHERE id = ?`)
    .get(projectId) as { dna_version: number | null } | undefined;

  if (!projRow || !projRow.dna_version || projRow.dna_version <= 0) {
    return null;
  }

  const dnaRow = db
    .prepare(
      `SELECT version, source, dna_json, hash, locked_at
       FROM channel_dna
       WHERE project_id = ? AND version = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(projectId, projRow.dna_version) as
    | {
        version: number;
        source: string;
        dna_json: string;
        hash: string;
        locked_at: string;
      }
    | undefined;

  if (!dnaRow) {
    return null;
  }

  try {
    const parsed = JSON.parse(dnaRow.dna_json) as ChannelDNA;
    return {
      dna: parsed,
      hash: dnaRow.hash,
      version: dnaRow.version,
      lockedAt: dnaRow.locked_at,
    };
  } catch {
    return null;
  }
}

function cascadeDnaDirtyIfDownstreamExists(
  db: DatabaseSync,
  projectId: string
): string[] {
  const existingStages = db
    .prepare(
      `SELECT stage_id FROM project_stages
       WHERE project_id = ? AND stage_id IN ('S1', 'S2', 'S2.5', 'S3', 'S4', 'S5', 'S6', 'S7')`
    )
    .all(projectId) as Array<{ stage_id: string }>;

  if (existingStages.length === 0) {
    return [];
  }

  const reason = 'DNA changed';
  db.prepare(
    `UPDATE project_stages
     SET is_dirty = 1,
         status = 'DIRTY',
         error_message = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ? AND stage_id = 'S1'`
  ).run(reason, projectId);

  const cascaded = markDownstreamStagesDirty(db, projectId, 'S1', reason);
  return ['S1', ...cascaded];
}

/**
 * C7: Locks a `ChannelDNA` profile for `projectId`, writing a new versioned row in `channel_dna`,
 * updating `projects.dna_version`, committing Stage `S0B` as `PASSED`, and marking downstream
 * stages `DIRTY` (`"DNA changed"`) if re-locked after S1+.
 */
export function handleLockChannelDna(params: {
  db: DatabaseSync;
  projectId: string;
  dna: Partial<ChannelDNA>;
}): {
  dna: ChannelDNA;
  version: number;
  hash: string;
  dirtyStages: string[];
} {
  const { db, projectId, dna: rawDna } = params;

  const maxRow = db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS max_ver FROM channel_dna WHERE project_id = ?`
    )
    .get(projectId) as { max_ver: number };

  const nextVersion = Number(maxRow?.max_ver ?? 0) + 1;
  const lockedAt = new Date().toISOString();

  const normalized = normalizeChannelDnaObject(
    {
      ...rawDna,
      version: nextVersion,
      lockedAt,
    },
    { version: nextVersion }
  );

  const dnaJson = JSON.stringify(normalized);
  const hash = computePayloadHash(dnaJson);

  db.prepare(
    `INSERT INTO channel_dna (project_id, version, source, dna_json, hash, locked_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(projectId, nextVersion, normalized.source, dnaJson, hash, lockedAt);

  // Sync niche and WPM (when measured) back to projects row
  if (normalized.voice.wpm && Number.isFinite(normalized.voice.wpm)) {
    db.prepare(
      `UPDATE projects
       SET dna_version = ?,
           niche = COALESCE(NULLIF(?, ''), niche),
           configured_wpm = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(nextVersion, normalized.identity.niche, normalized.voice.wpm, projectId);
  } else {
    db.prepare(
      `UPDATE projects
       SET dna_version = ?,
           niche = COALESCE(NULLIF(?, ''), niche),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(nextVersion, normalized.identity.niche, projectId);
  }

  commitStageState(db, {
    projectId,
    stageId: 'S0B',
    payload: {
      version: nextVersion,
      source: normalized.source,
      hash,
      fidelity: normalized.fidelity,
      niche: normalized.identity.niche,
      language: normalized.language,
      formatPreset: normalized.structure.formatPreset,
    },
    status: 'PASSED',
  });

  const dirtyStages =
    nextVersion > 1 ? cascadeDnaDirtyIfDownstreamExists(db, projectId) : [];

  return {
    dna: normalized,
    version: nextVersion,
    hash,
    dirtyStages,
  };
}

export function handleUnlockChannelDna(
  db: DatabaseSync,
  projectId: string
): { unlocked: boolean; dirtyStages: string[] } {
  db.prepare(
    `UPDATE projects SET dna_version = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(projectId);

  db.prepare(
    `UPDATE project_stages
     SET status = 'DIRTY', is_dirty = 1, error_message = 'DNA changed', updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ? AND stage_id = 'S0B'`
  ).run(projectId);

  const dirtyStages = cascadeDnaDirtyIfDownstreamExists(db, projectId);
  return { unlocked: true, dirtyStages };
}

/**
 * C8: Builds the stage-specific Channel DNA injection prompt block, incorporating
 * `computeFidelityWeights(dna.fidelity)` (`w_dna`, `w_creative`).
 */
export function buildChannelDnaPromptBlock(
  dna: ChannelDNA | null | undefined,
  stage: 'S1' | 'S2' | 'S2.5' | 'S3' | 'S5' | 'S6' | 'S7'
): string {
  if (!dna) {
    return '[CHANNEL_DNA: DEFAULT_UNCONFIGURED]';
  }

  const { dnaWeight, creativeWeight } = computeFidelityWeights(dna.fidelity);
  const header = `[LOCKED_CHANNEL_DNA v${dna.version} | source=${dna.source} | fidelity=${dna.fidelity}% (w_dna=${dnaWeight}, w_creative=${creativeWeight})]`;

  if (stage === 'S1') {
    return [
      header,
      `Niche & Sub-Niche: ${dna.identity.niche} / ${dna.identity.subNiche}`,
      `Content Pillars: ${dna.identity.pillars.join(' | ')}`,
      `Audience Persona: ${dna.identity.audiencePersona}`,
      `Primary Language: ${dna.language.primary} (Script: ${dna.language.script})`,
      `Winning Title Formulas: ${dna.packaging.titleFormulas.join(' ; ')} (max ${dna.packaging.titleCharMax} chars)`,
      `Outlier Insights (Do More): ${dna.performanceInsights.doMore.join(' ; ')}`,
      `Avoid: ${dna.performanceInsights.avoid.join(' ; ')}`,
    ].join('\n');
  }

  if (stage === 'S2' || stage === 'S2.5') {
    return [
      header,
      `Niche & Value Prop: ${dna.identity.niche} — ${dna.identity.valueProp}`,
      `Audience Persona: ${dna.identity.audiencePersona}`,
      `Narrative Format Preset: ${dna.structure.formatPreset}`,
      `Chapters (${dna.structure.chapters.length}): ${dna.structure.chapters
        .map((c) => `${c.name} (${c.sharePct}%)`)
        .join(', ')}`,
    ].join('\n');
  }

  if (stage === 'S3') {
    return [
      header,
      `Language: ${dna.language.primary} | Script: ${dna.language.script} | Code-Switch Ratio: ${dna.language.codeSwitchRatio} | Formality: ${dna.language.formality}`,
      `Voice Persona: ${dna.voice.persona}`,
      `Sentence Length Target: [${dna.voice.sentenceLen[0]}, ${dna.voice.sentenceLen[1]}] words | Paragraph Target: ~${dna.voice.paragraphWords} words`,
      `Hook Style (0-${dna.structure.hookSeconds}s): ${dna.structure.hookStyle}`,
      `Must-Use Phrases: ${dna.voice.mustUsePhrases.join(', ') || 'None'}`,
      `DNA Banned Words: ${dna.voice.bannedWords.join(', ') || 'None'}`,
    ].join('\n');
  }

  if (stage === 'S5' || stage === 'S6') {
    return [
      header,
      `Visual Style: ${dna.visuals.style}`,
      `Palette: ${dna.visuals.palette.join(', ')}`,
      `Lighting: ${dna.visuals.lighting.join(', ')}`,
      `Camera Motion: ${dna.visuals.cameraMotion.join(', ')}`,
      `Preferred Cut Range: ${dna.pacing.cutDurationSec[0]}-${dna.pacing.cutDurationSec[1]}s (clamped to model-locked pacing bounds)`,
      `DNA Visual Negative Prompts: ${dna.visuals.negativePrompts.join(', ') || 'None'}`,
    ].join('\n');
  }

  return [
    header,
    `Title Formulas: ${dna.packaging.titleFormulas.join(' ; ')} (max ${dna.packaging.titleCharMax} chars)`,
    `Overlay Rules: max ${dna.packaging.overlayRules.maxWords} words — ${dna.packaging.overlayRules.style}`,
    `Thumbnail Style: ${dna.packaging.thumbnailStyle.composition} | Palette: ${dna.packaging.thumbnailStyle.palette.join(', ')} | Face: ${dna.packaging.thumbnailStyle.faceUsage}`,
  ].join('\n');
}
