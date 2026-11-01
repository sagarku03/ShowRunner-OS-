import type {
  DurationPresetChip,
  GenerationMode,
  KeyValidationStatus,
  StageId as ConfigStageId,
  StageStatus,
  VideoProvider,
} from '../config/constants.ts';
import type { AuditCheckResult, AuditReport } from '../../shared/rules/audit.ts';
import type {
  DriftEvaluation,
  EmriEvaluation,
  HarmonPhaseBudget,
  WordBudgetResult,
} from '../../shared/rules/math.ts';
import type { StoryboardSlot, TranscriptWordTimestamp } from '../../shared/rules/slicer.ts';
import type { ParsedTranscriptMeta } from '../../shared/rules/transcript.ts';
import type {
  AssembledFlowPrompt,
  FlowPromptPack,
  PromptBatchCard,
} from '../../shared/rules/translate.ts';

export type HubId = 'vault' | 'topics' | 'studio' | 'script' | 'export';

export type StageId = ConfigStageId;

export interface DiscoveredModelsPayload {
  reasoningModels: string[];
  fastModels: string[];
  embeddingModels: string[];
}

export interface VaultKeyItem {
  id: number;
  projectLabel: string;
  keyType: 'GEMINI' | 'YOUTUBE';
  maskedKey: string;
  status: KeyValidationStatus | 'ACTIVE' | 'COOLDOWN_429' | 'EXHAUSTED' | 'INVALID' | 'UNREADABLE';
  cooldownUntil: string | null;
  failureCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  discoveredModels: DiscoveredModelsPayload;
  createdAt: string;
}

export interface LlmHealthData {
  activeKeys: number;
  validKeys: number;
  models: DiscoveredModelsPayload;
  lastError: string | null;
}

export interface DiscoveredModelItem {
  id: string;
  name: string;
  displayName: string;
  tier: 'TIER_REASONING' | 'TIER_FAST' | 'TIER_EMBEDDING';
  supportedGenerationMethods: string[];
}

export interface ModelDiscoveryData {
  reasoningModels: DiscoveredModelItem[];
  fastModels: DiscoveredModelItem[];
  embeddingModels: DiscoveredModelItem[];
  recommendedReasoning: string | null;
  recommendedFast: string | null;
  recommendedEmbedding: string | null;
}

import type { MasterPromptProfile } from '../../shared/rules/masterPromptProfile.ts';

export interface MasterPromptExtraction {
  persona: string;
  customChapters: string[];
  brandName: string;
  negativePrompts: string[];
  toneWords: string[];
  bannedWords: string[];
  profile?: MasterPromptProfile;
  insertedBlacklistIds?: number[];
}

export interface MasterPromptState {
  text: string;
  isUniversalMode: boolean;
  modeBadge?: string;
  modeLabel?: string;
  extracted: MasterPromptExtraction;
  extractionError?: string | null;
}

export interface DnaEvidenceCitation {
  videoId: string;
  field: string;
  excerpt?: string;
}

export interface ChannelDnaRecord {
  version: number;
  lockedAt: string;
  source: 'CHANNEL' | 'NICHE' | 'HYBRID' | 'EXPRESS' | 'ANALYSED' | 'MASTER_PROMPT';
  fidelity: number;
  channelMeta?: {
    id: string;
    handle: string;
    title: string;
    subs: number;
    totalViews: number;
    videoCount: number;
    analysedIds: string[];
  };
  referenceTitles?: string[];
  identity: {
    niche: string;
    subNiche: string;
    format: string[];
    valueProp: string;
    cadencePerMonth: number;
  };
  language: {
    primary: string;
    script: string;
    register: string;
    hinglishRatio: number;
    forbiddenLexicon: string[];
    transitionWords: string[];
  };
  titleArchetypes: Array<{
    pattern: string;
    weight: number;
    avgCtrProxy: number;
    evidence: DnaEvidenceCitation[];
  }>;
  thumbnailPsychology: {
    dominantEmotion: string;
    fucksOrFacs: string;
    composition: string;
    textOverlayStyle: string;
    colorContrast: string;
    avoidList: string[];
    evidence: DnaEvidenceCitation[];
  };
  hookDNA: {
    first15sPattern: string;
    openLoopStyle: string;
    emotionalPull: string;
    avoidInHook: string[];
    evidence: DnaEvidenceCitation[];
  };
  pacingAndMetrics: {
    wpm: number;
    sentenceLengthMin: number;
    sentenceLengthMax: number;
    targetDurationMin: number;
    preferredCutRangeSec: [number, number];
  };
  narrativeStructure: {
    template: string;
    phases: Array<{ name: string; pct: number; role: string }>;
    loopCadenceSec: number;
    evidence: DnaEvidenceCitation[];
  };
  linguisticVoice: {
    register: string;
    perspective: string;
    TransitionLexicon: string[];
    forbiddenPhrases: string[];
    ttsSafe: boolean;
  };
  visualDirection: {
    aesthetic: string;
    Palette: string[];
    motionBias: string;
    defaultLighting: string;
    negativeAdditions: string[];
  };
  audienceAndPositioning: {
    avatar: string;
    painPoints: string[];
    contentGaps: string[];
    antiTopics: string[];
  };
  confidence: Record<string, 'HIGH' | 'MEDIUM' | 'LOW'>;
  hash: string;
}

export interface NicheStyleOption {
  id: string;
  label: string;
  tagline: string;
  channelDna: ChannelDnaRecord;
}

export interface DiagnosticsData {
  timestamp: string;
  runtimeMode: string;
  port: number;
  bindAddress: string;
  tokenConfigured: boolean;
  clientAuthActive: boolean;
  nodeVersion: string;
  platform: string;
  arch: string;
  uptimeSec: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  database: {
    dbSize: number;
    walSize: number;
    totalSizeBytes: number;
  };
  geminiKeys: {
    total: number;
    valid: number;
    lastCheckedAt: string | null;
  };
  youtubeKey: {
    configured: boolean;
    valid: boolean;
    status: string;
  };
  discoveredModels: DiscoveredModelsPayload;
  lastLogs: string[];
}

export interface ProjectItem {
  id: string;
  name: string;
  niche: string;
  brandName: string;
  entryMode?: 'FULL' | 'EXPRESS';
  lockedTopic: string | null;
  targetDuration: number;
  targetWords: number;
  configuredWpm: number;
  actualWpm: number | null;
  activeState: StageId;
  generationMode: GenerationMode;
  videoProvider: VideoProvider;
  defaultClipDuration: number;
  reasoningModel: string | null;
  fastModel: string | null;
  embeddingModel: string | null;
  smartTiering: boolean;
  masterPrompt: string | null;
  masterPromptExtracted: MasterPromptExtraction | null;
  dnaVersion: number | null;
  epoch: number;
  createdAt: string;
  updatedAt: string;
}

export interface StageStateSummary<T = unknown> {
  stageId: StageId;
  status: StageStatus;
  isDirty: boolean;
  payloadHash: string;
  updatedAt: string;
  payload: T | null;
}

export interface PipelineStateVector {
  projectId: string;
  current: StageId;
  history: StageId[];
  context: Record<string, StageStateSummary>;
  integrityHash: string;
  epoch: number;
}

export interface TopicCard {
  id: string;
  title: string;
  hook15s: string;
  coreParadox: string;
  thumbnailIdea: string;
  hook: string;
  paradox: string;
  thumbnailBoldWords: string;
  retentionScore: number;
  mdviScore: number;
}

export interface CustomTopicAlignmentResult {
  mode: 'custom';
  aligned: boolean;
  topic: string;
  niche: string;
  score: number;
  categoryConflict: boolean;
  reasoning: string;
  reframingAngles: [string, string, string];
  lockedTopic?: TopicCard | null;
}

export interface S1StagePayload {
  mode?: 'ideate' | 'custom';
  niche: string;
  candidates: TopicCard[];
  lockedTopic: TopicCard | null;
  customAlignment?: CustomTopicAlignmentResult | null;
}

export interface EvidenceRow {
  id: string;
  claim: string;
  leadSource: string;
  institution: string;
  year: string;
  methodology: string;
  link: string;
  status: 'VERIFIED' | 'EXCLUDED';
}

export interface KnowledgeTriple {
  subject: string;
  predicate: string;
  object: string;
  evidenceId: string;
}

export interface S2StagePayload {
  topicTitle: string;
  step2aMarkdown: string;
  shockPoint: {
    fact: string;
    source: string;
    link: string;
  };
  evidence: EvidenceRow[];
  triples: KnowledgeTriple[];
  clusters: Array<{ name: string; facts: string[] }>;
  mdvi: {
    score: number;
    breakdown: {
      scientificDepth: number;
      narrativeFriction: number;
      visualDensity: number;
    };
  };
  grounding: {
    queries: string[];
    sources: Array<{ uri: string; title: string }>;
  };
  approved: boolean;
  approvedHash: string | null;
  primaryAnchor: string;
  counterAnchor: string;
}

export interface HarmonChapterPlan extends HarmonPhaseBudget {
  chapterTitle: string;
  narrativeBeat: string;
  anchorIds: string[];
}

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

export interface S25StagePayload {
  durationPreset?: DurationPresetChip;
  targetMinutes: number;
  wpm: number;
  wordBudget: WordBudgetResult;
  chapters: HarmonChapterPlan[];
  metaphorCandidates: MetaphorCandidate[];
  selectedMetaphor: MetaphorCandidate;
}

export interface ScriptParagraphNode {
  id: number;
  phase: string;
  chapterTitle: string;
  text: string;
  spokenText: string;
  word_count: number;
}

export interface S3StagePayload {
  paragraphs: ScriptParagraphNode[];
  box1Text: string;
  box2Text: string;
  glossary: Array<{ term: string; meaning: string; usage: string }>;
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

export interface S4StagePayload {
  words: TranscriptWordTimestamp[];
  actualDurationSec: number;
  targetDurationSec: number;
  driftEvaluation: DriftEvaluation;
  drift: boolean;
  driftPct: number;
  suggestedWpm: number;
  rollbackTo: 'S3' | null;
  estimateOnlyPreview?: boolean;
  meta?: ParsedTranscriptMeta;
}

export interface S5StagePayload {
  mode: GenerationMode;
  provider: VideoProvider;
  defaultClipDuration: number;
  actualDurationSec: number;
  targetDurationSec: number;
  driftEvaluation: DriftEvaluation;
  slotCount: number;
  slots: StoryboardSlot[];
}

export interface S6StagePayload {
  mode: GenerationMode;
  styleSource?: 'DNA' | 'NEUTRAL_DEFAULT';
  totalPrompts: number;
  totalBatches: number;
  batches: PromptBatchCard[];
  packCount: number;
  prompts: AssembledFlowPrompt[];
  packs: FlowPromptPack[];
}

export interface PackagingVariant {
  id: 'PACK_A' | 'PACK_B' | 'PACK_C';
  variantName: string;
  archetype: string;
  title: string;
  overlayText: string;
  thumbnailPrompt: string;
  subjectScalePercent: number;
  bottomRightSafeZonePct: number;
  zeroWordOverlap: boolean;
  emri: EmriEvaluation;
}

export interface S7StagePayload {
  variants: PackagingVariant[];
  selectedPackId: 'PACK_A' | 'PACK_B' | 'PACK_C' | null;
  emri: EmriEvaluation;
  seoMatrix: {
    primaryTitle: string;
    aboveTheFoldDescription: string;
    description: string;
    tags: string[];
    fourTierTags: {
      broad: string[];
      subNiche: string[];
      entity: string[];
      longTail: string[];
      combinedCsv: string;
      totalCharCount: number;
    };
    chaptersText: string;
    pinnedComment: string;
  };
  bundleFiles: string[];
}

export type { AuditCheckResult, AuditReport };
