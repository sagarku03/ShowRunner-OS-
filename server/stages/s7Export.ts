import JSZip from 'jszip';
import type { DatabaseSync } from 'node:sqlite';
import { Type, type Schema } from '@google/genai';
import {
  ABOVE_THE_FOLD_DESC_CHARS,
  APP_VERSION,
  EMRI_MAX_PASS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
  REFERENCE_SIMILARITY_MAX,
} from '../../src/config/constants.ts';
import { computeEmriFromVectors, type EmriEvaluation } from '../../shared/rules/math.ts';
import { formatStoryboardCsv, formatTimedWordsToSrt } from '../../shared/rules/slicer.ts';
import { containsRawAuCode } from '../../shared/rules/translate.ts';
import { assertStageUnlocked, getStageRow } from '../fsm/gates.ts';
import { commitStageState } from '../fsm/machine.ts';
import type { GeminiGateway } from '../llm/gemini.ts';
import { checkReferenceSimilarity, createYouTubeError } from '../youtube/client.ts';
import { buildMasterPromptInjectionBlock } from './s0MasterPrompt.ts';
import { buildChannelDnaPromptBlock, getLockedChannelDna } from './s0bChannelDna.ts';
import { enforceMaxTitleChars } from './s1Topics.ts';
import type { Stage2ResearchPayload } from './s2Research.ts';
import type { Stage25RuntimePayload } from './s3Arch.ts';
import type { Stage3ScriptPayload } from './s4Script.ts';
import type { Stage4TranscriptPayload, Stage5StoryboardPayload } from './s5Audio.ts';
import type { Stage6PromptsPayload } from './s6Prompts.ts';

export interface PackagingVariant {
  id: 'PACK_A' | 'PACK_B' | 'PACK_C';
  variantName: string;
  archetype:
    | 'Immediate Visceral Shock'
    | 'High-Stakes Conflict'
    | 'Human Scale Paradox';
  title: string;
  overlayText: string;
  thumbnailPrompt: string;
  subjectScalePercent: number;
  bottomRightSafeZonePct: number;
  zeroWordOverlap: boolean;
  emri: EmriEvaluation;
  thumbnailConcept: string;
  boldWords: string;
  facsDescription: string;
}

export interface FourTierTags {
  broad: string[];
  subNiche: string[];
  entity: string[];
  longTail: string[];
  combinedCsv: string;
  totalCharCount: number;
  ratioBreakdown: {
    broadPct: number;
    subNichePct: number;
    entityPct: number;
    longTailPct: number;
  };
}

export interface Stage7ExportPayload {
  variants: PackagingVariant[];
  selectedPackId: 'PACK_A' | 'PACK_B' | 'PACK_C' | null;
  emri: EmriEvaluation;
  seoMatrix: {
    primaryTitle: string;
    aboveTheFoldDescription: string;
    description: string;
    tags: string[];
    fourTierTags: FourTierTags;
    chaptersText: string;
    pinnedComment: string;
  };
  bundleFiles: string[];
}

const PACKAGING_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    variants: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          title: { type: Type.STRING },
          overlayText: { type: Type.STRING },
          thumbnailPrompt: { type: Type.STRING },
        },
        required: ['id', 'title', 'overlayText', 'thumbnailPrompt'],
      },
    },
    tags: {
      type: Type.OBJECT,
      properties: {
        broad: { type: Type.ARRAY, items: { type: Type.STRING } },
        subNiche: { type: Type.ARRAY, items: { type: Type.STRING } },
        entity: { type: Type.ARRAY, items: { type: Type.STRING } },
        longTail: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['broad', 'subNiche', 'entity', 'longTail'],
    },
    pinnedComment: { type: Type.STRING },
  },
  required: ['variants', 'tags', 'pinnedComment'],
};

/**
 * Validates that `rawOverlay` has 2..maxWords uppercase words and zero word overlap with `title`.
 * No hard-coded fallback bank is used (Part A5).
 */
export function enforceZeroOverlapOverlay(
  title: string,
  rawOverlay: string,
  maxOverlayWords: number = 4
): { overlayText: string; zeroWordOverlap: boolean; valid: boolean } {
  const titleWords = new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F\s]/gi, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );

  const rawWords = (rawOverlay || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const nonOverlapping = rawWords.filter((w) => !titleWords.has(w.toLowerCase()));
  const overlayText = nonOverlapping.slice(0, maxOverlayWords).join(' ');
  const hasOverlap =
    rawWords.length > 0 &&
    rawWords.some((w) => titleWords.has(w.toLowerCase())) &&
    nonOverlapping.length < 2;

  const valid = nonOverlapping.length >= 2 && !hasOverlap;
  return {
    overlayText,
    zeroWordOverlap: !hasOverlap && nonOverlapping.length >= 2,
    valid,
  };
}

export function buildFourTierTags(rawTags: {
  broad?: string[];
  subNiche?: string[];
  entity?: string[];
  longTail?: string[];
}): FourTierTags {
  const defaultBroad = ['Deep Dive'];
  const defaultSubNiche = ['Evidence Analysis', 'Case Study'];
  const defaultEntity = [
    'Empirical Study',
    'Primary Source',
    'Clinical Evidence',
    'Systemic Analysis',
  ];
  const defaultLongTail = [
    'hidden paradox explained',
    'in-depth analysis',
    'verified case study',
  ];

  const broad = [...(rawTags.broad || []), ...defaultBroad]
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 1);
  const subNiche = [...(rawTags.subNiche || []), ...defaultSubNiche]
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 2);
  const entity = [...(rawTags.entity || []), ...defaultEntity]
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 4);
  const longTail = [...(rawTags.longTail || []), ...defaultLongTail]
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3);

  const ordered = [...broad, ...subNiche, ...entity, ...longTail];
  const fitted: string[] = [];
  let runningLength = 0;

  for (const tag of ordered) {
    const addition = fitted.length === 0 ? tag.length : tag.length + 2;
    if (runningLength + addition <= MAX_TAG_CHARS) {
      fitted.push(tag);
      runningLength += addition;
    }
  }

  const combinedCsv = fitted.join(', ');
  return {
    broad,
    subNiche,
    entity,
    longTail,
    combinedCsv,
    totalCharCount: combinedCsv.length,
    ratioBreakdown: {
      broadPct: 10,
      subNichePct: 20,
      entityPct: 40,
      longTailPct: 30,
    },
  };
}

export function buildAboveTheFoldSpoDescription(
  triples: Stage2ResearchPayload['triples'],
  fallbackTopic: string
): string {
  if (Array.isArray(triples) && triples.length > 0) {
    const sentences = triples
      .slice(0, 2)
      .map((t) => `${t.subject} ${t.predicate} ${t.object}.`.replace(/\s+/g, ' ').trim());
    const joined = sentences.join(' ');
    if (joined.length <= ABOVE_THE_FOLD_DESC_CHARS) {
      return joined;
    }
    return joined.slice(0, ABOVE_THE_FOLD_DESC_CHARS - 3).trim() + '...';
  }
  const fallback = `${fallbackTopic}: primary-source investigation reveals the verified truth.`;
  return fallback.slice(0, ABOVE_THE_FOLD_DESC_CHARS);
}

/**
 * Stage 7: Packaging, Thumbnail FACS & SEO Engine (Part A5, B, C8).
 * Zero silent packaging fallbacks: if the LLM returns < 3 valid variants, retries up to 2 times
 * with the exact failure reason, then throws typed `PACKAGING_INCOMPLETE`.
 */
export async function handleGeneratePackaging(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string
): Promise<Stage7ExportPayload> {
  assertStageUnlocked(db, projectId, 'S7');

  const projMeta = db
    .prepare(`SELECT entry_mode, locked_topic, name, niche FROM projects WHERE id = ?`)
    .get(projectId) as
    | { entry_mode?: string; locked_topic?: string; name: string; niche: string }
    | undefined;
  const isExpress = projMeta?.entry_mode === 'EXPRESS';

  const s4Row = getStageRow(db, projectId, 'S4');
  const s5Row = getStageRow(db, projectId, 'S5');
  const s6Row = getStageRow(db, projectId, 'S6');

  if (!s4Row || !s5Row || !s6Row) {
    throw new Error('Upstream stages S4..S6 must be completed before Stage 7 Packaging.');
  }

  const s2Row = getStageRow(db, projectId, 'S2');
  const s25Row = getStageRow(db, projectId, 'S2.5');
  const s3Row = getStageRow(db, projectId, 'S3');

  if (!isExpress && (!s2Row || !s25Row || !s3Row)) {
    throw new Error('Upstream stages S2..S6 must be completed before Stage 7 Packaging.');
  }

  const s2 = s2Row?.payload_json ? (JSON.parse(s2Row.payload_json) as Stage2ResearchPayload) : undefined;
  const s25 = s25Row?.payload_json ? (JSON.parse(s25Row.payload_json) as Stage25RuntimePayload) : undefined;
  const s3 = s3Row?.payload_json ? (JSON.parse(s3Row.payload_json) as Stage3ScriptPayload) : undefined;
  const s4 = JSON.parse(s4Row.payload_json) as Stage4TranscriptPayload;
  const s6 = JSON.parse(s6Row.payload_json) as Stage6PromptsPayload;

  let topicTitle = s2?.topicTitle || projMeta?.locked_topic || projMeta?.name || 'Voiceover Analysis';
  let shockPointFact = s2?.shockPoint?.fact || '';
  let triples = s2?.triples || [];

  if (!s2 || !s2.shockPoint) {
    const transcriptTextSample = (s4.words || []).slice(0, 150).map((w) => w.word).join(' ');
    try {
      const derived = await gemini.generateStructured<{
        topicTitle: string;
        shockPoint: string;
        triples: Array<{ subject: string; predicate: string; object: string }>;
      }>({
        db,
        projectId,
        stage: 'S7_EXPRESS_DERIVE_TOPIC',
        tier: 'TIER_FAST',
        systemInstruction:
          'You are the ShowRunner Express Script Analyzer. Derive a concise topic summary and extract 3 core subject-predicate-object triples from the user script.',
        userPrompt: `Script excerpt: "${transcriptTextSample}". Return topicTitle, shockPoint, and 3 triples.`,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            topicTitle: { type: Type.STRING },
            shockPoint: { type: Type.STRING },
            triples: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  subject: { type: Type.STRING },
                  predicate: { type: Type.STRING },
                  object: { type: Type.STRING },
                },
                required: ['subject', 'predicate', 'object'],
              },
            },
          },
          required: ['topicTitle', 'shockPoint', 'triples'],
        },
      });

      if (!projMeta?.locked_topic && derived.data.topicTitle) {
        topicTitle = derived.data.topicTitle;
      }
      shockPointFact = derived.data.shockPoint || transcriptTextSample.slice(0, 100);
      triples = (derived.data.triples || []).map((t, idx) => ({
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        evidenceId: `express-${idx + 1}`,
        claimsSource: 'USER_SCRIPT' as const,
      }));
    } catch (_err) {
      shockPointFact = transcriptTextSample.slice(0, 80);
      triples = [
        {
          subject: topicTitle,
          predicate: 'exhibits core mechanism described in',
          object: 'voiceover script',
          evidenceId: 'express-1',
          claimsSource: 'USER_SCRIPT' as const,
        },
      ];
    }
  }

  const lockedDna = getLockedChannelDna(db, projectId)?.dna;
  const masterBlock = buildMasterPromptInjectionBlock(db, projectId);
  const dnaBlock = buildChannelDnaPromptBlock(lockedDna, 'S7');
  const titleCharCap = lockedDna?.packaging.titleCharMax ?? MAX_TITLE_CHARS;
  const maxOverlayWords = lockedDna?.packaging.overlayRules.maxWords ?? 4;
  const referenceTitles = lockedDna?.referenceTitles ?? [];

  const first30sWords = (s4.words || [])
    .filter((w) => w.startSec <= 30)
    .map((w) => w.word)
    .join(' ');
  const transcriptFirst30s =
    first30sWords.trim() || s3?.paragraphs[0]?.text || shockPointFact || topicTitle;

  const systemInstruction = [
    'You are the Stage 7 Packaging, Thumbnail FACS & SEO Engine for ShowRunner OS v1.3.1.',
    'Generate 3 distinct packaging variants:',
    '- PACK_A: Immediate Visceral Shock',
    '- PACK_B: High-Stakes Conflict',
    '- PACK_C: Human Scale Paradox (subject occupies ~35% of frame height against massive architectural/environmental scale)',
    'Rules for each variant:',
    `1. title MUST be strictly under ${titleCharCap} characters.`,
    `2. overlayText MUST be 2-${maxOverlayWords} bold words with ZERO word overlap with title.`,
    '3. thumbnailPrompt MUST describe facial expressions in natural anatomical FACS prose (NEVER output raw numeric Action Unit codes) and MUST explicitly preserve a clean bottom-right 20% timestamp safe zone.',
    '4. Provide 4-tier tags: broad (10%), subNiche (20%), entity (40%), longTail (30%).',
    dnaBlock,
    masterBlock,
  ].join('\n');

  const archetypes: Array<{
    id: 'PACK_A' | 'PACK_B' | 'PACK_C';
    variantName: string;
    archetype: PackagingVariant['archetype'];
    subjectScalePercent: number;
  }> = [
    {
      id: 'PACK_A',
      variantName: 'Pack A — Immediate Visceral Shock',
      archetype: 'Immediate Visceral Shock',
      subjectScalePercent: 68,
    },
    {
      id: 'PACK_B',
      variantName: 'Pack B — High-Stakes Conflict',
      archetype: 'High-Stakes Conflict',
      subjectScalePercent: 55,
    },
    {
      id: 'PACK_C',
      variantName: 'Pack C — Human Scale Paradox (35% Scale)',
      archetype: 'Human Scale Paradox',
      subjectScalePercent: 35,
    },
  ];

  let builtVariantsDraft: Array<{
    id: 'PACK_A' | 'PACK_B' | 'PACK_C';
    variantName: string;
    archetype: PackagingVariant['archetype'];
    subjectScalePercent: number;
    title: string;
    overlayText: string;
    thumbnailPrompt: string;
    bottomRightSafeZonePct: number;
    zeroWordOverlap: boolean;
  }> = [];
  let rawTagsOut: {
    broad: string[];
    subNiche: string[];
    entity: string[];
    longTail: string[];
  } = { broad: [], subNiche: [], entity: [], longTail: [] };
  let pinnedCommentOut = '';
  let lastFailureReason = '';

  // Bounded retry up to 2 times (3 total attempts) if < 3 valid variants returned (Part A5)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const userPrompt = [
      `Topic: ${topicTitle}`,
      `Shock Point: ${shockPointFact}`,
      `First 30s Transcript Hook: ${transcriptFirst30s}`,
      `MMKG Triples: ${JSON.stringify(triples.slice(0, 4))}`,
      lastFailureReason
        ? `RETRY #${attempt - 1} REQUIRED — PREVIOUS PACKAGING REJECTED: ${lastFailureReason}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const packRes = await gemini.generateStructured<{
      variants: Array<{
        id: string;
        title: string;
        overlayText: string;
        thumbnailPrompt: string;
      }>;
      tags: {
        broad: string[];
        subNiche: string[];
        entity: string[];
        longTail: string[];
      };
      pinnedComment: string;
    }>({
      db,
      projectId,
      stage: 'S7',
      tier: 'TIER_REASONING',
      systemInstruction,
      userPrompt,
      responseSchema: PACKAGING_SCHEMA,
      temperature: 0.3,
    });

    const rawVariants = Array.isArray(packRes.data.variants) ? packRes.data.variants : [];
    if (rawVariants.length < 3) {
      lastFailureReason = `Returned ${rawVariants.length} variants instead of 3 required variants (PACK_A, PACK_B, PACK_C).`;
      continue;
    }

    const candidateDrafts: typeof builtVariantsDraft = [];
    let attemptFailed = false;

    for (let idx = 0; idx < 3; idx++) {
      const arch = archetypes[idx];
      const raw =
        rawVariants.find((v) => String(v.id || '').toUpperCase() === arch.id) ||
        rawVariants[idx];

      if (
        !raw ||
        !raw.title?.trim() ||
        !raw.overlayText?.trim() ||
        !raw.thumbnailPrompt?.trim()
      ) {
        lastFailureReason = `Variant ${arch.id} is missing title, overlayText, or thumbnailPrompt.`;
        attemptFailed = true;
        break;
      }

      const cleanTitle = enforceMaxTitleChars(raw.title, titleCharCap);
      if (referenceTitles.length > 0) {
        const sim = checkReferenceSimilarity(
          cleanTitle,
          referenceTitles,
          REFERENCE_SIMILARITY_MAX
        );
        if (!sim.passed) {
          lastFailureReason = `Variant ${arch.id} title "${cleanTitle}" is too close (${sim.maxSimilarity}) to reference title "${sim.closestReference}".`;
          if (attempt === 3) {
            throw createYouTubeError(
              'REFERENCE_SIMILARITY_EXCEEDED',
              lastFailureReason,
              422
            );
          }
          attemptFailed = true;
          break;
        }
      }

      const { overlayText, zeroWordOverlap, valid: overlayValid } = enforceZeroOverlapOverlay(
        cleanTitle,
        raw.overlayText,
        maxOverlayWords
      );
      if (!overlayValid || !zeroWordOverlap) {
        lastFailureReason = `Variant ${arch.id} overlayText "${raw.overlayText}" overlapped with title "${cleanTitle}" or had fewer than 2 words.`;
        attemptFailed = true;
        break;
      }

      let cleanThumbPrompt = raw.thumbnailPrompt
        .replace(/\bAU\s*-?\s*\d+[A-Z]?\b/gi, 'visceral anatomical micro-expression')
        .trim();

      if (!cleanThumbPrompt.toLowerCase().includes('bottom-right 20%')) {
        cleanThumbPrompt +=
          ' Leave the bottom-right 20% of the frame unobstructed as a clean timestamp safe zone.';
      }
      if (arch.id === 'PACK_C' && !cleanThumbPrompt.includes('35%')) {
        cleanThumbPrompt +=
          ' Scale Paradox composition: human subject occupies 35% of frame height dwarfed by the surrounding environment.';
      }

      if (containsRawAuCode(cleanThumbPrompt)) {
        lastFailureReason = `Variant ${arch.id} thumbnailPrompt contained forbidden raw FACS AU code.`;
        attemptFailed = true;
        break;
      }

      candidateDrafts.push({
        ...arch,
        title: cleanTitle,
        overlayText,
        thumbnailPrompt: cleanThumbPrompt,
        bottomRightSafeZonePct: 20,
        zeroWordOverlap,
      });
    }

    if (!attemptFailed && candidateDrafts.length === 3) {
      builtVariantsDraft = candidateDrafts;
      rawTagsOut = packRes.data.tags || { broad: [], subNiche: [], entity: [], longTail: [] };
      pinnedCommentOut = packRes.data.pinnedComment || '';
      break;
    }
  }

  if (builtVariantsDraft.length < 3) {
    const err = new Error(
      `PACKAGING_INCOMPLETE: Stage 7 failed to produce 3 valid packaging variants after 3 attempts (${lastFailureReason}).`
    ) as Error & { code: string; statusCode: number };
    err.code = 'PACKAGING_INCOMPLETE';
    err.statusCode = 422;
    throw err;
  }

  const aboveTheFoldDescription = buildAboveTheFoldSpoDescription(triples, topicTitle);

  const textsToEmbed = [
    ...builtVariantsDraft.map(
      (v) => `${v.title} | ${v.overlayText} | ${aboveTheFoldDescription}`
    ),
    transcriptFirst30s,
  ];

  const embedRes = await gemini.embedTexts({
    db,
    projectId,
    stage: 'S7_EMRI',
    texts: textsToEmbed,
  });

  const transcriptVec = embedRes.vectors[embedRes.vectors.length - 1];

  const variants: PackagingVariant[] = builtVariantsDraft.map((draft, idx) => {
    const packVec = embedRes.vectors[idx] || transcriptVec;
    const emri = computeEmriFromVectors(packVec, transcriptVec, EMRI_MAX_PASS);
    return {
      id: draft.id,
      variantName: draft.variantName,
      archetype: draft.archetype,
      title: draft.title,
      overlayText: draft.overlayText,
      thumbnailPrompt: draft.thumbnailPrompt,
      subjectScalePercent: draft.subjectScalePercent,
      bottomRightSafeZonePct: draft.bottomRightSafeZonePct,
      zeroWordOverlap: draft.zeroWordOverlap,
      emri,
      thumbnailConcept: draft.thumbnailPrompt,
      boldWords: draft.overlayText,
      facsDescription: draft.thumbnailPrompt,
    };
  });

  const passingVariant = variants.find((v) => v.emri.passed) || null;
  const bestVariant = [...variants].sort((a, b) => a.emri.emriScore - b.emri.emriScore)[0];

  const fourTierTags = buildFourTierTags(rawTagsOut);
  const chaptersList = s25?.chapters || [
    { chapterTitle: 'Opening & Hook' },
    { chapterTitle: 'Core Analysis' },
    { chapterTitle: 'Conclusion & Synthesis' },
  ];
  const chaptersText = chaptersList
    .map((c: { chapterTitle: string }, idx: number) => {
      const approxSec = Math.round(
        (idx / Math.max(1, chaptersList.length)) * s4.actualDurationSec
      );
      const mm = String(Math.floor(approxSec / 60)).padStart(2, '0');
      const ss = String(approxSec % 60).padStart(2, '0');
      return `${mm}:${ss} ${c.chapterTitle}`;
    })
    .join('\n');

  const verifiedClaimsList = s2?.verifiedClaims || [];
  const fullDescription = [
    aboveTheFoldDescription,
    '',
    'Chapters:',
    chaptersText,
    ...(verifiedClaimsList.length > 0
      ? [
          '',
          'Verified Sources:',
          ...verifiedClaimsList
            .slice(0, 5)
            .map((c) => `- ${c.institution} (${c.year}): ${c.sourceUrl}`),
        ]
      : []),
  ].join('\n');

  const bundleFiles = [
    'Hindi_Script_Spoken.txt',
    'TTS_Input_Phonetic.txt',
    'Synced_Transcript.srt',
    'Visual_Storyboard.csv',
    ...s6.packs.map((p) => p.fileName),
    'Packaging_3Packs_And_SEO.json',
    'Channel_DNA.json',
    'Project_Manifest.json',
  ];

  const payload: Stage7ExportPayload = {
    variants,
    selectedPackId: passingVariant ? passingVariant.id : null,
    emri: passingVariant ? passingVariant.emri : bestVariant.emri,
    seoMatrix: {
      primaryTitle: (passingVariant || bestVariant).title,
      aboveTheFoldDescription,
      description: fullDescription,
      tags: fourTierTags.combinedCsv.split(', ').filter(Boolean),
      fourTierTags,
      chaptersText,
      pinnedComment:
        pinnedCommentOut ||
        `What stood out to you most about ${topicTitle}? Share your thoughts below.`,
    },
    bundleFiles,
  };

  commitStageState(db, {
    projectId,
    stageId: 'S7',
    payload,
    status: passingVariant ? 'PASSED' : 'FAILED',
  });

  if (!passingVariant) {
    const err = new Error(
      `EMRI Gate Failed: lowest pack EMRI was ${bestVariant.emri.emriScore} (must be < ${EMRI_MAX_PASS}).`
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 422;
    err.code = 'EMRI_GATE_FAILED';
    throw err;
  }

  return payload;
}

export function handleSelectPackagingPack(
  db: DatabaseSync,
  projectId: string,
  packId: 'PACK_A' | 'PACK_B' | 'PACK_C'
): Stage7ExportPayload {
  const s7Row = getStageRow(db, projectId, 'S7');
  if (!s7Row) {
    throw new Error('Stage 7 packaging has not been generated yet.');
  }

  const payload = JSON.parse(s7Row.payload_json) as Stage7ExportPayload;
  const target = payload.variants.find((v) => v.id === packId);
  if (!target) {
    throw new Error(`Packaging variant "${packId}" not found.`);
  }
  if (!target.emri.passed) {
    const err = new Error(
      `Cannot select ${packId}: EMRI score ${target.emri.emriScore} >= ${EMRI_MAX_PASS}.`
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 422;
    err.code = 'EMRI_GATE_FAILED';
    throw err;
  }

  payload.selectedPackId = target.id;
  payload.emri = target.emri;
  payload.seoMatrix.primaryTitle = target.title;

  commitStageState(db, {
    projectId,
    stageId: 'S7',
    payload,
    status: 'PASSED',
  });

  return payload;
}

export async function buildMasterExportZip(
  db: DatabaseSync,
  projectId: string
): Promise<{ fileName: string; buffer: Buffer }> {
  const s3Row = getStageRow(db, projectId, 'S3');
  const s4Row = getStageRow(db, projectId, 'S4');
  const s5Row = getStageRow(db, projectId, 'S5');
  const s6Row = getStageRow(db, projectId, 'S6');
  const s7Row = getStageRow(db, projectId, 'S7');

  const projectRow = db
    .prepare('SELECT entry_mode FROM projects WHERE id = ?')
    .get(projectId) as { entry_mode?: string } | undefined;
  const isExpress = projectRow?.entry_mode === 'EXPRESS' || s3Row?.status === 'EXTERNAL_PROVIDED';

  const requiredStages = isExpress
    ? [s4Row, s5Row, s6Row, s7Row]
    : [s3Row, s4Row, s5Row, s6Row, s7Row];

  if (requiredStages.some((r) => !r) || s7Row?.status !== 'PASSED') {
    const err = new Error(
      'Cannot export Master Bundle: Stage 7 Packaging & EMRI Gate (< 20) must be PASSED and a pack selected.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 409;
    err.code = 'EXPORT_NOT_READY';
    throw err;
  }

  const s3 = s3Row?.payload_json ? (JSON.parse(s3Row.payload_json) as Stage3ScriptPayload) : null;
  const s4 = JSON.parse(s4Row!.payload_json) as Stage4TranscriptPayload;
  const s5 = JSON.parse(s5Row!.payload_json) as Stage5StoryboardPayload;
  const s6 = JSON.parse(s6Row!.payload_json) as Stage6PromptsPayload;
  const s7 = JSON.parse(s7Row!.payload_json) as Stage7ExportPayload;

  if (s4.estimateOnlyPreview) {
    const err = new Error(
      'TRANSCRIPT_REQUIRED: Estimate-only preview transcripts can never be exported.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 422;
    err.code = 'TRANSCRIPT_REQUIRED';
    throw err;
  }

  if (!s7.selectedPackId) {
    const err = new Error(
      'Please select a passing Packaging Variant (Pack A/B/C) before exporting.'
    ) as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 409;
    err.code = 'PACK_NOT_SELECTED';
    throw err;
  }

  const zip = new JSZip();
  const lockedDnaRecord = getLockedChannelDna(db, projectId);

  const spokenScript = s3?.box1Text || s4.words.map((w: any) => w.word).join(' ');
  const phoneticScript = s3?.box2Text || spokenScript;

  zip.file('Hindi_Script_Spoken.txt', spokenScript);
  zip.file('Script_Spoken.txt', spokenScript);
  zip.file('TTS_Input_Phonetic.txt', phoneticScript);
  zip.file('Synced_Transcript.srt', formatTimedWordsToSrt(s4.words));
  zip.file('Visual_Storyboard.csv', formatStoryboardCsv(s5.slots));

  for (const pack of s6.packs) {
    zip.file(pack.fileName, pack.content);
  }

  zip.file(
    'Packaging_3Packs_And_SEO.json',
    JSON.stringify(
      {
        selectedPackId: s7.selectedPackId,
        variants: s7.variants,
        emri: s7.emri,
        seoMatrix: s7.seoMatrix,
      },
      null,
      2
    )
  );

  zip.file(
    'Channel_DNA.json',
    JSON.stringify(
      lockedDnaRecord
        ? {
            version: lockedDnaRecord.version,
            hash: lockedDnaRecord.hash,
            lockedAt: lockedDnaRecord.lockedAt,
            dna: lockedDnaRecord.dna,
          }
        : { version: 0, dna: null },
      null,
      2
    )
  );

  const precisionGrade =
    s4.meta?.precisionGrade ??
    (s4.meta?.hasEstimatedWords ? 'CUE_INTERPOLATED' : 'WORD_EXACT_MS');

  zip.file(
    'Project_Manifest.json',
    JSON.stringify(
      {
        version: APP_VERSION,
        projectId,
        exportedAt: new Date().toISOString(),
        mode: s5.mode,
        provider: s5.provider,
        actualDurationSec: s4.actualDurationSec,
        transcriptFormat: s4.meta?.format ?? 'UNKNOWN',
        transcriptPrecisionGrade: precisionGrade,
        hasEstimatedWords: Boolean(s4.meta?.hasEstimatedWords),
        confirmEstimated: Boolean(s4.meta?.confirmEstimated),
        transcriptFileName: s4.meta?.fileName ?? null,
        slotCount: s5.slotCount,
        packCount: s6.packCount,
        selectedPackId: s7.selectedPackId,
        emriScore: s7.emri.emriScore,
        dnaVersion: lockedDnaRecord?.version ?? 0,
        dnaHash: lockedDnaRecord?.hash ?? null,
        channelDna: lockedDnaRecord?.dna ?? null,
      },
      null,
      2
    )
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  return {
    fileName: `ShowRunner_${projectId}_v${APP_VERSION}_MasterBundle.zip`,
    buffer,
  };
}
