import {
  FLOW_PACK_MAX_PROMPTS,
  MAX_KINETIC_VERBS_PER_PROMPT,
  NEUTRAL_CAMERA_MOTION,
  NEUTRAL_ENVIRONMENT,
  NEUTRAL_LIGHTING,
  NEUTRAL_STYLE_PREFIX,
  PROMPT_BATCH_SIZE,
  R5_NEGATIVE_PROMPT_SUFFIX,
  type GenerationMode,
} from '../../src/config/constants.ts';
import { cosineSimilarity } from './math.ts';
import type { StoryboardSlot } from './slicer.ts';
import { formatTimestampTag } from './timestamps.ts';

const FACS_EMOTION_PROSE_MAP: Record<string, string> = {
  SHOCK:
    'upper eyelids pulled sharply upward exposing scleral rim, brow arches elevated in sudden cognitive arrest, jaw slightly parted with tense masseter muscle definition',
  DREAD:
    'inner brow corners drawn together and upward with deep glabellar furrows, lower eyelids tensed, lips pressed in restrained visceral apprehension',
  CONTEMPLATION:
    'orbicularis oculi gently narrowed in analytical focus, brow lowered with steady gaze fixation, subtle micro-tension along the jawline',
  REVELATION:
    'brows lifting smoothly as pupils dilate under sudden comprehension, parted lips and relaxed lower face signaling cognitive breakthrough',
  URGENCY:
    'corrugator supercilii contracted into sharp vertical brow lines, nostrils slightly flared, taut facial musculature under high-stakes temporal pressure',
  TENSION:
    'narrowed palpebral fissures with locked ocular focus, compressed lip corners, and pronounced sternocleidomastoid neck tension',
};

const CAMERA_RIG_VECTORS: ReadonlyArray<{
  name: string;
  description: string;
  vector: [number, number, number];
}> = [
  {
    name: 'SLOW_DOLLY_IN',
    description: NEUTRAL_CAMERA_MOTION,
    vector: [0.92, 0.35, 0.17],
  },
  {
    name: 'PARALLAX_SLIDE',
    description: '50mm prime lens executing a controlled lateral parallax slider translation',
    vector: [0.85, 0.48, 0.21],
  },
  {
    name: 'PEDESTAL_RISE',
    description: '40mm cinema prime on a hydraulic column rising smoothly with subtle tilt',
    vector: [0.82, 0.42, 0.38],
  },
  {
    name: 'MACRO_LOCKED_RACK',
    description: '85mm macro cinema lens holding a stabilized frame with precision depth-of-field rack focus',
    vector: [0.89, 0.39, 0.22],
  },
];

const RAW_AU_CODE_REGEX = /\bAU\s*-?\s*\d+[A-Z]?\b/gi;

export function containsRawAuCode(text: string): boolean {
  RAW_AU_CODE_REGEX.lastIndex = 0;
  return RAW_AU_CODE_REGEX.test(text);
}

export function stripRawAuCodes(text: string): string {
  return text.replace(RAW_AU_CODE_REGEX, 'natural anatomical micro-expression').replace(/\s{2,}/g, ' ').trim();
}

export function enforceKineticVerbCap(
  actionClause: string,
  maxVerbs: number = MAX_KINETIC_VERBS_PER_PROMPT
): { clause: string; verbCount: number } {
  const kineticVerbs = [
    'pushes',
    'glides',
    'pans',
    'tilts',
    'tracks',
    'sweeps',
    'rises',
    'descends',
    'pivots',
    'drifts',
    'converges',
    'illuminates',
    'reveals',
    'shifts',
    'rotates',
    'expands',
    'contracts',
  ];

  const words = actionClause.split(/\s+/);
  let count = 0;
  const filtered = words.filter((word) => {
    const clean = word.toLowerCase().replace(/[^a-z]/g, '');
    if (kineticVerbs.includes(clean)) {
      if (count >= maxVerbs) {
        return false;
      }
      count += 1;
    }
    return true;
  });

  return {
    clause: filtered.join(' '),
    verbCount: Math.min(count, maxVerbs),
  };
}

export type VisualFrameType = 'PROTAGONIST' | 'OBJECT' | 'SCENIC';

export interface SlotVisualSpec {
  slotIndex: number;
  subjectDescription: string;
  environmentDescription: string;
  actionTrajectory: string;
  emotionTag: keyof typeof FACS_EMOTION_PROSE_MAP | string;
  lightingSpec?: string;
  frameType?: VisualFrameType;
}

export interface AssembledFlowPrompt {
  slotIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  actionSec: number;
  holdSec: number;
  cameraRig: string;
  continuityCosineWithPrev: number;
  kineticVerbCount: number;
  styleSource: 'DNA' | 'NEUTRAL_DEFAULT';
  promptText: string;
  promptLine: string;
}

export function assembleFlowPrompts(params: {
  slots: ReadonlyArray<StoryboardSlot>;
  visualSpecs: ReadonlyArray<SlotVisualSpec>;
  mode: GenerationMode;
  extraNegativePrompts?: ReadonlyArray<string>;
  defaultLightingHint?: string;
  stylePrefix?: string;
  lightingPreference?: string;
  flowNatural?: boolean;
  characterAnchor?: string;
  noCliFlags?: boolean;
}): AssembledFlowPrompt[] {
  const {
    slots,
    visualSpecs,
    mode,
    extraNegativePrompts,
    defaultLightingHint,
    stylePrefix,
    lightingPreference,
    flowNatural = false,
    characterAnchor,
    noCliFlags = false,
  } = params;
  const results: AssembledFlowPrompt[] = [];
  let prevVector: [number, number, number] = CAMERA_RIG_VECTORS[0].vector;

  const trimmedPrefix = (stylePrefix || '').trim();
  const hasCustomStyle = Boolean(trimmedPrefix && trimmedPrefix !== NEUTRAL_STYLE_PREFIX);
  const effectivePrefix = trimmedPrefix || NEUTRAL_STYLE_PREFIX;
  const styleSource: 'DNA' | 'NEUTRAL_DEFAULT' = hasCustomStyle ? 'DNA' : 'NEUTRAL_DEFAULT';

  const cleanNegativeItem = (s: string): string => {
    let t = stripRawAuCodes(String(s));
    // Strip CLI flags like --no, --ar 16:9, --v 6, etc.
    t = t.replace(/--(?:no|ar|v|stylize|s|chaos)\b[^\s,]*/gi, '').trim();
    t = t.replace(/^--no\s+/i, '').replace(/^[,\s]+|[,\s]+$/g, '').trim();
    return t;
  };

  const extraNegClean = (extraNegativePrompts ?? [])
    .map(cleanNegativeItem)
    .filter(Boolean);

  const fullNegativeSuffix =
    extraNegClean.length > 0
      ? `${R5_NEGATIVE_PROMPT_SUFFIX}, ${extraNegClean.join(', ')}`
      : R5_NEGATIVE_PROMPT_SUFFIX;

  slots.forEach((slot, idx) => {
    const spec = visualSpecs[idx] ?? {
      slotIndex: slot.slotIndex,
      subjectDescription: 'Primary narrative focal subject with balanced key composition',
      environmentDescription: NEUTRAL_ENVIRONMENT,
      actionTrajectory: 'camera pushes slowly toward the primary evidence focal plane',
      emotionTag: 'CONTEMPLATION',
    };

    const candidateRig = CAMERA_RIG_VECTORS[idx % CAMERA_RIG_VECTORS.length];
    let selectedRig = candidateRig;
    let cos = cosineSimilarity(prevVector, candidateRig.vector);
    if (cos < 0.707) {
      selectedRig = CAMERA_RIG_VECTORS[0];
      cos = cosineSimilarity(prevVector, selectedRig.vector);
    }
    prevVector = selectedRig.vector;

    const facsProse =
      FACS_EMOTION_PROSE_MAP[String(spec.emotionTag).toUpperCase()] ??
      FACS_EMOTION_PROSE_MAP.CONTEMPLATION;

    const { clause: cappedAction, verbCount } = enforceKineticVerbCap(
      stripRawAuCodes(spec.actionTrajectory)
    );

    let cleanSubject = stripRawAuCodes(spec.subjectDescription);
    let cleanEnv = stripRawAuCodes(spec.environmentDescription);
    let lighting = stripRawAuCodes(
      lightingPreference ??
        spec.lightingSpec ??
        defaultLightingHint ??
        NEUTRAL_LIGHTING
    );

    if (noCliFlags || flowNatural) {
      cleanSubject = cleanSubject.replace(/--(?:no|ar|v|stylize|s|chaos)\b[^\s,]*/gi, '').trim();
      cleanEnv = cleanEnv.replace(/--(?:no|ar|v|stylize|s|chaos)\b[^\s,]*/gi, '').trim();
      lighting = lighting.replace(/--(?:no|ar|v|stylize|s|chaos)\b[^\s,]*/gi, '').trim();
    }

    const startTag =
      slot.timestampTag && /^#\[\d{2,}-\d{2}\.\d{3}\]$/.test(slot.timestampTag)
        ? slot.timestampTag
        : formatTimestampTag(
            typeof slot.startMs === 'number' ? slot.startMs : slot.startSec,
            'bracketed',
            typeof slot.startMs === 'number'
          );

    const isMode2 = mode === 'MODE_2_CONTINUOUS' || mode === 'MODE_2' || mode === 'MODE_2_VIDEO';
    const mode2Tag = isMode2 ? ` @start:${startTag}` : '';

    let singleLinePrompt: string;

    if (flowNatural) {
      // Natural prompt syntax:
      // #[MM-SS.mmm] <style prefix> <character anchor + pose | object + (no human figure in frame) | scenic + (no stickman in frame)>. <environment>. <lighting>. Widescreen 16:9 composition. Avoid <negatives>.
      const frameType = spec.frameType || 'PROTAGONIST';
      let subjectClause = cleanSubject;

      if (frameType === 'OBJECT') {
        const marker = '(no human figure in frame)';
        subjectClause = subjectClause.includes(marker) ? subjectClause : `${subjectClause}, ${marker}`;
      } else if (frameType === 'SCENIC') {
        const marker = '(no stickman in frame)';
        subjectClause = subjectClause.includes(marker) ? subjectClause : `${subjectClause}, ${marker}`;
      } else {
        // PROTAGONIST
        if (characterAnchor && characterAnchor.trim()) {
          const anchorTrim = characterAnchor.trim();
          if (!subjectClause.toLowerCase().includes(anchorTrim.toLowerCase().slice(0, 15))) {
            subjectClause = `${anchorTrim}, ${subjectClause}`;
          }
        }
      }

      const ensurePeriod = (text: string) => {
        const t = text.trim().replace(/[.,;]+$/, '');
        return t ? `${t}.` : '';
      };

      const styleClause = effectivePrefix.trim().replace(/,+$/, '');
      const subjectFormatted = ensurePeriod(subjectClause);
      const envFormatted = ensurePeriod(cleanEnv);
      const lightFormatted = ensurePeriod(lighting);

      // Negatives for flowNatural:
      const negItems = [
        ...extraNegClean,
        '3D render',
        'CGI animation',
        'photorealism',
        'airbrushed',
        'unrendered vectors',
        'low quality',
        'watermark',
      ];
      // Deduplicate case-insensitively
      const seenNegs = new Set<string>();
      const uniqueNegs: string[] = [];
      for (const item of negItems) {
        const key = item.toLowerCase();
        if (!seenNegs.has(key)) {
          seenNegs.add(key);
          uniqueNegs.push(item);
        }
      }
      const avoidClause = `Avoid ${uniqueNegs.join(', ')}.`;

      singleLinePrompt = [
        `${startTag} ${styleClause} ${subjectFormatted}`,
        envFormatted,
        lightFormatted,
        'Widescreen 16:9 composition.',
        avoidClause,
        mode2Tag ? mode2Tag.trim() : '',
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\r?\n+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    } else {
      const timingDirective =
        mode === 'MODE_1_IMAGE' || mode === 'MODE_1'
          ? `Static high-resolution keyframe hold (${slot.durationSec.toFixed(2)}s) with ${slot.actionSec.toFixed(2)}s primary focal emphasis and ${slot.holdSec.toFixed(2)}s residual atmospheric settle, camera holds a steady residual micro-tension frame`
          : `Continuous ${slot.durationSec.toFixed(2)}s shot: primary kinetic action completes within 0.00s-${slot.actionSec.toFixed(2)}s (${cappedAction}), followed by a ${slot.holdSec.toFixed(2)}s micro-tension residual hold (${slot.actionSec.toFixed(2)}s-${slot.durationSec.toFixed(2)}s) where the camera holds a steady residual micro-tension frame`;

      singleLinePrompt = [
        `${startTag} ${effectivePrefix},`,
        `${selectedRig.description}.`,
        `Subject: ${cleanSubject}, exhibiting ${facsProse}.`,
        `Environment: ${cleanEnv}.`,
        `Motion & Pacing: ${timingDirective}.`,
        `Lighting: ${lighting}.${mode2Tag}`,
        fullNegativeSuffix,
      ]
        .join(' ')
        .replace(/\r?\n+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    results.push({
      slotIndex: slot.slotIndex,
      startSec: slot.startSec,
      endSec: slot.endSec,
      durationSec: slot.durationSec,
      actionSec: slot.actionSec,
      holdSec: slot.holdSec,
      cameraRig: selectedRig.name,
      continuityCosineWithPrev: Number(cos.toFixed(4)),
      kineticVerbCount: verbCount,
      styleSource,
      promptText: singleLinePrompt,
      promptLine: singleLinePrompt,
    });
  });

  return results;
}

export interface PromptBatchCard {
  batchIndex: number;
  totalBatches: number;
  label: string;
  promptCount: number;
  startSlotIndex: number;
  endSlotIndex: number;
  prompts: string[];
  content: string;
}

export function buildPromptBatches(
  prompts: ReadonlyArray<AssembledFlowPrompt>,
  batchSize: number = PROMPT_BATCH_SIZE
): PromptBatchCard[] {
  const batches: PromptBatchCard[] = [];
  const totalBatches = Math.max(1, Math.ceil(prompts.length / batchSize));

  for (let i = 0; i < prompts.length; i += batchSize) {
    const chunk = prompts.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize) + 1;
    const singleLineStrings = chunk.map((p) =>
      p.promptText.replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    );
    batches.push({
      batchIndex,
      totalBatches,
      label: `Batch ${batchIndex}/${totalBatches}`,
      promptCount: chunk.length,
      startSlotIndex: chunk[0].slotIndex,
      endSlotIndex: chunk[chunk.length - 1].slotIndex,
      prompts: singleLineStrings,
      content: singleLineStrings.join('\n\n'),
    });
  }

  return batches;
}

export interface FlowPromptPack {
  packIndex: number;
  fileName: string;
  promptCount: number;
  startSlotIndex: number;
  endSlotIndex: number;
  content: string;
}

export function buildFlowPromptPacks(
  prompts: ReadonlyArray<AssembledFlowPrompt>,
  maxPerPack: number = FLOW_PACK_MAX_PROMPTS
): FlowPromptPack[] {
  const packs: FlowPromptPack[] = [];
  for (let i = 0; i < prompts.length; i += maxPerPack) {
    const chunk = prompts.slice(i, i + maxPerPack);
    const packIndex = Math.floor(i / maxPerPack) + 1;
    const fileName = `Flow_Prompt_Pack_${String(packIndex).padStart(2, '0')}.txt`;
    const content = chunk
      .map((p) => p.promptText.replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim())
      .join('\n\n');

    packs.push({
      packIndex,
      fileName,
      promptCount: chunk.length,
      startSlotIndex: chunk[0].slotIndex,
      endSlotIndex: chunk[chunk.length - 1].slotIndex,
      content,
    });
  }
  return packs;
}
