/**
 * ShowRunner OS v1.3.0 — Central Deterministic Constants & Thresholds
 * Every threshold, regex, and ratio from PRD v1.3.0 is defined once here.
 */

export const APP_VERSION = '1.3.0' as const;

export const STAGE_IDS = [
  'S0',
  'S0B',
  'S1',
  'S2',
  'S2.5',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
  'S_error',
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export const LINEAR_PIPELINE_STAGES: ReadonlyArray<StageId> = [
  'S0',
  'S1',
  'S2',
  'S2.5',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
];

export type StageStatus =
  | 'PENDING'
  | 'PASSED'
  | 'FAILED'
  | 'DIRTY'
  | 'INVALIDATED'
  | 'EXTERNAL_PROVIDED';

export type KeyValidationStatus =
  | 'VALID'
  | 'INVALID_KEY'
  | 'QUOTA_EXCEEDED'
  | 'MODEL_ACCESS_DENIED'
  | 'NETWORK_ERROR'
  | 'COOLING_DOWN';

export type ModelTier = 'TIER_REASONING' | 'TIER_FAST' | 'TIER_EMBEDDING';

export type GenerationMode =
  | 'MODE_1_IMAGE'
  | 'MODE_2_VIDEO'
  | 'MODE_2_CONTINUOUS'
  | 'MODE_3_DIRECT_VIDEO'
  | 'MODE_1'
  | 'MODE_2'
  | 'MODE_3';

export type VideoProvider = 'OMNI_FLASH' | 'VEO_3_1' | 'VO3_1';

// ============================================================================
// STAGE 0: VAULT & CIRCUIT BREAKER CONSTANTS
// ============================================================================
export const KEY_COOLDOWN_MS = 60_000;
export const COOLDOWN_429_MS = KEY_COOLDOWN_MS;
export const MAX_KEY_ROTATION_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 400;
export const BACKOFF_CAP_MS = 8_000;
export const WS_HEARTBEAT_INTERVAL_MS = 10_000;
export const HEAP_GC_THRESHOLD_BYTES = 384 * 1024 * 1024;
export const HEAP_CHECK_INTERVAL_MS = 30_000;

export const REASONING_MODEL_PATTERNS: ReadonlyArray<RegExp> = [
  /gemini-(?:[0-9.]+-)?pro/i,
  /pro-preview/i,
  /thinking/i,
];

export const FAST_MODEL_PATTERNS: ReadonlyArray<RegExp> = [
  /gemini-(?:[0-9.]+-)?flash/i,
  /flash-preview/i,
  /flash-lite/i,
];

export const EMBEDDING_MODEL_PATTERNS: ReadonlyArray<RegExp> = [
  /embedding/i,
];

export const EXCLUDED_MODEL_PATTERNS: ReadonlyArray<RegExp> = [
  /vision-only/i,
  /aqa/i,
  /imagen/i,
  /veo/i,
  /lyria/i,
  /tts/i,
  /audio/i,
];


// ============================================================================
// STAGE 1 & 2: IDEATION, CUSTOM ALIGNMENT & MDVI THRESHOLDS (G1, G2, G3)
// ============================================================================
export const TOPIC_CARD_COUNT = 10;
export const MAX_TITLE_CHARS = 60;
export const CUSTOM_TOPIC_ALIGNMENT_PASS = 70;
export const MDVI_THRESHOLD = 70;

// ============================================================================
// STAGE 2.5 & 3: WPM, WORD BUDGET, HARMON WEIGHTS & METAPHOR (G5, G13)
// ============================================================================
export const DEFAULT_WPM = 187.41;
export const WPM_MIN = 160;
export const WPM_MAX = 210;
export const WORD_TOLERANCE = 0.05;
export const WORDS_PER_PARAGRAPH_TARGET = 150;
export const SUB_LOOP_MIN_WPM_MULT = 1.0;
export const SUB_LOOP_MAX_WPM_MULT = 1.5;

export const DURATION_PRESET_CHIPS = ['6-8', '10-12', '12-15', '18-20'] as const;
export type DurationPresetChip = (typeof DURATION_PRESET_CHIPS)[number];

export const DURATION_PRESET_MIDPOINTS: Record<DurationPresetChip, number> = {
  '6-8': 7,
  '10-12': 11,
  '12-15': 13.5,
  '18-20': 19,
};

export interface HarmonPhaseSpec {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly weight: number;
}

export const HARMON_WEIGHT_DENOMINATOR = 97;

export const HARMON_PHASES: ReadonlyArray<HarmonPhaseSpec> = [
  { index: 1, id: 'H1_COMFORT', name: '1. You (Comfort Zone)', weight: 11 },
  { index: 2, id: 'H2_NEED', name: '2. Need (Disruption)', weight: 15 },
  { index: 3, id: 'H3_GO', name: '3. Go (Crossing Threshold)', weight: 16 },
  { index: 4, id: 'H4_SEARCH', name: '4. Search (Road of Trials)', weight: 11 },
  { index: 5, id: 'H5_FIND', name: '5. Find (The Revelation)', weight: 16 },
  { index: 6, id: 'H6_TAKE', name: '6. Take (The Price Paid)', weight: 15 },
  { index: 7, id: 'H7_RETURN', name: '7. Return & Change', weight: 13 },
] as const;

export const METAPHOR_PASS_SCORE = 36;

// ============================================================================
// STAGE 3: 17-POINT AUDIT & TRI-NODE SURGICAL REPAIR (G8, G9, G10)
// ============================================================================
export const SENTENCE_WORDS_MIN = 14;
export const SENTENCE_WORDS_MAX = 22;
export const HOOK_WINDOW_SEC = 15;
export const PIVOT_WINDOW_SEC = 30;
export const OPEN_LOOP_WINDOW_SEC = 45;
export const OPEN_LOOP_WPM_FACTOR = 0.75;
export const K_MAX_REPAIRS = 3;

export const BANNED_HINDI_PHRASES: ReadonlyArray<string> = [
  'साबित कर दिया',
  'पक्की मौत',
  'दिमाग हिला देगा',
  'होश उड़ा देगा',
  'पूरी तरह से बदल दिया',
  'अंत तक देखें',
];

export const BANNED_ENGLISH_PHRASES: ReadonlyArray<string> = [
  'in this video we will discuss',
  'without further ado',
  'smash that like button',
  'mind blowing secret',
  'watch till the end',
  'delve into',
];

export const CAUSAL_CONJUNCTIONS: ReadonlyArray<string> = [
  'लेकिन',
  'इसलिए',
  'क्योंकि',
  'जबकि',
  'इसके बावजूद',
  'नतीजतन',
  'परिणामस्वरूप',
  'परंतु',
  'फिर भी',
  'however',
  'therefore',
  'because',
  'consequently',
  'meanwhile',
  'nevertheless',
  'but',
];

// ============================================================================
// STAGE S0B: CHANNEL DNA, FORMAT PRESETS & FIDELITY CONSTANTS (Part B & C)
// ============================================================================
export const UNIVERSAL_CREATOR_MODE_LABEL = 'Universal Any-Niche Creator Mode' as const;
export const DEFAULT_DNA_FIDELITY = 70;
export const REFERENCE_SIMILARITY_MAX = 0.78;
export const CHANNEL_MIN_PUBLIC_VIDEOS = 5;
export const CHANNEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const CHANNEL_SAMPLE_COUNTS = {
  QUICK: 4,
  STANDARD: 8,
  DEEP: 15,
} as const;

export type ChannelAnalysisDepth = keyof typeof CHANNEL_SAMPLE_COUNTS;

export function computeFidelityWeights(fidelity: number): {
  dnaWeight: number;
  creativeWeight: number;
} {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(fidelity) ? fidelity : DEFAULT_DNA_FIDELITY));
  const dnaWeight = Number((clamped / 100).toFixed(2));
  const creativeWeight = Number((1 - dnaWeight).toFixed(2));
  return { dnaWeight, creativeWeight };
}

export type NarrativeFormatPresetId = 'DOCUMENTARY' | 'EXPLAINER' | 'STORYTIME' | 'LISTICLE';

export interface FormatPhaseShare {
  readonly id: string;
  readonly name: string;
  readonly sharePct: number;
}

export const FORMAT_PRESETS: Record<NarrativeFormatPresetId, ReadonlyArray<FormatPhaseShare>> = {
  DOCUMENTARY: [
    { id: 'H1_COMFORT', name: '1. You (Status Quo)', sharePct: 11 },
    { id: 'H2_NEED', name: '2. Need (Anomaly)', sharePct: 15 },
    { id: 'H3_GO', name: '3. Go (Investigation)', sharePct: 17 },
    { id: 'H4_SEARCH', name: '4. Search (Evidence Trail)', sharePct: 12 },
    { id: 'H5_FIND', name: '5. Find (The Twist)', sharePct: 17 },
    { id: 'H6_TAKE', name: '6. Take (The Cost)', sharePct: 15 },
    { id: 'H7_RETURN', name: '7. Return (Resolution)', sharePct: 13 },
  ],
  EXPLAINER: [
    { id: 'E1_HOOK_PROBLEM', name: '1. Hook & Problem Statement', sharePct: 14 },
    { id: 'E2_INTUITION', name: '2. Core Intuition & Mental Model', sharePct: 18 },
    { id: 'E3_MECHANISM', name: '3. Step-by-Step Mechanism', sharePct: 24 },
    { id: 'E4_EDGE_CASE', name: '4. Counter-Example / Pitfall', sharePct: 18 },
    { id: 'E5_REAL_WORLD', name: '5. Real-World Application', sharePct: 15 },
    { id: 'E6_TAKEAWAY', name: '6. Synthesis & Actionable Takeaway', sharePct: 11 },
  ],
  STORYTIME: [
    { id: 'S1_COLD_OPEN', name: '1. In Medias Res Cold Open', sharePct: 12 },
    { id: 'S2_STAKES', name: '2. Setup & Personal Stakes', sharePct: 16 },
    { id: 'S3_INCITING', name: '3. Inciting Complication', sharePct: 18 },
    { id: 'S4_ESCALATION', name: '4. Escalating Crisis', sharePct: 22 },
    { id: 'S5_CLIMAX', name: '5. Climax & Turning Point', sharePct: 18 },
    { id: 'S6_AFTERMATH', name: '6. Aftermath & Reflection', sharePct: 14 },
  ],
  LISTICLE: [
    { id: 'L1_HOOK_CRITERIA', name: '1. Hook & Ranking Criteria', sharePct: 10 },
    { id: 'L2_ENTRY_WARMUP', name: '2. Contenders & Context', sharePct: 20 },
    { id: 'L3_MID_TIER_PIVOT', name: '3. Mid-Tier Game Changers', sharePct: 24 },
    { id: 'L4_RUNNER_UP', name: '4. Runner-Up Breakdown', sharePct: 22 },
    { id: 'L5_TOP_PICK', name: '5. #1 Pick & Verdict', sharePct: 24 },
  ],
} as const;

export const NEUTRAL_STYLE_PREFIX =
  '16:9 widescreen crisp digital cinematography, natural studio balance, neutral chromatic range' as const;
export const DEFAULT_STYLE_PREFIX_LABEL = 'Default style – set DNA to customise' as const;

export const FORMAT_PRESET_DEFAULT_STYLE_PREFIXES: Record<NarrativeFormatPresetId, string> = {
  DOCUMENTARY: '16:9 widescreen archival cinematic frame, tactile realism, muted cinematic palette',
  EXPLAINER: '16:9 widescreen clean high-definition graphic and motion-render staging, crisp edge delineation',
  STORYTIME: '16:9 widescreen immersive narrative cinematography, dramatic atmospheric depth',
  LISTICLE: '16:9 widescreen high-energy polished studio presentation, vibrant high-contrast lighting',
};

// ============================================================================
// STAGE 4 & 5: DRIFT THRESHOLD & MODEL-LOCKED PACING TABLE (G4, G11)
// ============================================================================
export const DRIFT_THRESHOLD = 0.05;
export const TRANSCRIPT_DRIFT_MAX_RATIO = DRIFT_THRESHOLD;

export interface PacingBound {
  readonly minSec: number;
  readonly maxSec: number;
  readonly actionRatio: number;
  readonly holdRatio: number;
}

export const OMNI_FLASH_DURATIONS = [4, 6, 8, 10] as const;
export const VEO_3_1_FIXED_DURATION = 8 as const;
export const VO31_FIXED_DURATION = 8 as const;

export const MODEL_LOCKED_PACING_TABLE: Record<string, PacingBound> = {
  'MODE_1:ANY:ANY': { minSec: 1.0, maxSec: 2.8, actionRatio: 0.7, holdRatio: 0.3 },
  'VIDEO:OMNI_FLASH:4': { minSec: 2.2, maxSec: 3.8, actionRatio: 0.7, holdRatio: 0.3 },
  'VIDEO:OMNI_FLASH:6': { minSec: 3.8, maxSec: 5.8, actionRatio: 0.7, holdRatio: 0.3 },
  'VIDEO:OMNI_FLASH:8': { minSec: 4.5, maxSec: 7.8, actionRatio: 0.7, holdRatio: 0.3 },
  'VIDEO:VEO_3_1:8': { minSec: 4.5, maxSec: 7.8, actionRatio: 0.7, holdRatio: 0.3 },
  'VIDEO:OMNI_FLASH:10': { minSec: 6.5, maxSec: 9.8, actionRatio: 0.7, holdRatio: 0.3 },
};

export function resolveModelLockedPacing(params: {
  mode: GenerationMode;
  provider?: VideoProvider;
  engine?: VideoProvider | string;
  durationSec?: number;
}): PacingBound {
  if (params.mode === 'MODE_1_IMAGE' || params.mode === 'MODE_1') {
    return MODEL_LOCKED_PACING_TABLE['MODE_1:ANY:ANY'];
  }
  const rawProvider = String(params.provider ?? params.engine ?? 'VEO_3_1').toUpperCase();
  const normProvider = rawProvider === 'VO3_1' ? 'VEO_3_1' : rawProvider;
  const dur = Number(params.durationSec ?? (normProvider === 'VEO_3_1' ? 8 : 8));
  const key = `VIDEO:${normProvider}:${dur}`;
  const bound = MODEL_LOCKED_PACING_TABLE[key];
  if (!bound) {
    const err = new Error(
      `Unsupported pacing combo: mode=${params.mode}, provider=${normProvider}, durationSec=${dur}`
    ) as Error & { code?: string; statusCode?: number };
    err.code = 'UNSUPPORTED_PACING_COMBO';
    err.statusCode = 422;
    throw err;
  }
  return bound;
}

// ============================================================================
// STAGE 6 & 7: BATCHES, PACKS, EMRI (<20) & TAGS (G6, G7, G14)
// ============================================================================
export const PROMPT_BATCH_SIZE = 30;
export const FLOW_PACK_MAX_PROMPTS = 100;
export const MAX_KINETIC_VERBS_PER_PROMPT = 4;

export const R5_NEGATIVE_PROMPT_SUFFIX =
  '--no text overlays, watermarks, subtitles, morphing anatomy, extra limbs, distorted fingers, floating artifacts, split screen, abrupt jump cuts, neon oversaturation, raw FACS AU codes';

export const EMRI_MAX_PASS = 20.0;
export const MAX_TAG_CHARS = 500;
export const TAG_TIER_RATIOS = {
  broad: 0.1,
  subNiche: 0.2,
  entity: 0.4,
  longTail: 0.3,
} as const;
export const ABOVE_THE_FOLD_DESC_CHARS = 150;
