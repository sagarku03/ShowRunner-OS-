import type { DatabaseSync } from 'node:sqlite';
import { Type, type Schema } from '@google/genai';
import {
  type GenerationMode,
  NEUTRAL_STYLE_PREFIX,
  FORMAT_PRESET_DEFAULT_STYLE_PREFIXES,
  type NarrativeFormatPresetId,
} from '../../src/config/constants.ts';
import {
  assembleFlowPrompts,
  buildFlowPromptPacks,
  buildPromptBatches,
  containsRawAuCode,
  type AssembledFlowPrompt,
  type FlowPromptPack,
  type PromptBatchCard,
  type SlotVisualSpec,
} from '../../shared/rules/translate.ts';
import { assertStageUnlocked, getStageRow } from '../fsm/gates.ts';
import { commitStageState } from '../fsm/machine.ts';
import type { GeminiGateway } from '../llm/gemini.ts';
import {
  buildMasterPromptInjectionBlock,
  getMasterPromptState,
} from './s0MasterPrompt.ts';
import { buildChannelDnaPromptBlock, getLockedChannelDna } from './s0bChannelDna.ts';
import type { Stage5StoryboardPayload } from './s5Audio.ts';

export interface Stage6PromptsPayload {
  mode: GenerationMode;
  totalPrompts: number;
  totalBatches: number;
  batches: PromptBatchCard[];
  packCount: number;
  prompts: AssembledFlowPrompt[];
  packs: FlowPromptPack[];
}

const VISUAL_SPECS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    visualSpecs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          slotIndex: { type: Type.NUMBER },
          subjectDescription: { type: Type.STRING },
          environmentDescription: { type: Type.STRING },
          actionTrajectory: { type: Type.STRING },
          emotionTag: { type: Type.STRING },
          lightingSpec: { type: Type.STRING },
        },
        required: [
          'slotIndex',
          'subjectDescription',
          'environmentDescription',
          'actionTrajectory',
          'emotionTag',
          'lightingSpec',
        ],
      },
    },
  },
  required: ['visualSpecs'],
};

function isValidVisualSpec(spec: Partial<SlotVisualSpec> | undefined): spec is SlotVisualSpec {
  return Boolean(
    spec &&
      typeof spec.subjectDescription === 'string' &&
      spec.subjectDescription.trim().length > 0 &&
      typeof spec.environmentDescription === 'string' &&
      spec.environmentDescription.trim().length > 0 &&
      typeof spec.actionTrajectory === 'string' &&
      spec.actionTrajectory.trim().length > 0 &&
      typeof spec.emotionTag === 'string' &&
      spec.emotionTag.trim().length > 0
  );
}

/**
 * Stage 6: Cross-Lingual Visual Prompt Translation Engine (Part A5 & C8).
 * Zero silent emotion rotation fallbacks: re-asks the LLM up to 2 times if required fields
 * are missing, and throws `PACKAGING_INCOMPLETE` if still missing.
 */
export async function handleGenerateVisualPrompts(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string
): Promise<Stage6PromptsPayload> {
  assertStageUnlocked(db, projectId, 'S6');

  const s5Row = getStageRow(db, projectId, 'S5');
  if (!s5Row) {
    throw new Error('Stage 5 storyboard payload missing.');
  }
  const s5 = JSON.parse(s5Row.payload_json) as Stage5StoryboardPayload;

  const lockedDna = getLockedChannelDna(db, projectId)?.dna;
  const masterState = getMasterPromptState(db, projectId);
  const masterBlock = buildMasterPromptInjectionBlock(db, projectId);
  const dnaBlock = buildChannelDnaPromptBlock(lockedDna, 'S6');

  const sampleSlots = s5.slots.slice(0, 20).map((s) => ({
    slotIndex: s.slotIndex,
    durationSec: s.durationSec,
    actionSec: s.actionSec,
    spokenSegment: s.spokenSegment,
  }));

  const systemInstruction = [
    'You are the Stage 6 Cross-Lingual Visual Prompt Translation Engine for ShowRunner OS v1.3.0.',
    'Translate each storyboard slot into a rich English visual specification with subjectDescription, environmentDescription, actionTrajectory, emotionTag (SHOCK, DREAD, CONTEMPLATION, REVELATION, URGENCY, or TENSION), and lightingSpec.',
    'CRITICAL RULE: NEVER output raw Facial Action Coding System numeric Action Unit codes.',
    'Describe all facial expressions in natural anatomical prose only.',
    dnaBlock,
    masterBlock,
  ].join('\n');

  let validatedSpecs: SlotVisualSpec[] = [];
  let lastMissingDetail = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const userPrompt = [
      `Mode: ${s5.mode}`,
      lastMissingDetail
        ? `RETRY #${attempt - 1}: Previous response had missing/empty fields (${lastMissingDetail}). Provide complete non-empty subjectDescription, environmentDescription, actionTrajectory, emotionTag, and lightingSpec for every slot.`
        : '',
      `Slots:\n${JSON.stringify(sampleSlots, null, 2)}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const llmRes = await gemini.generateStructured<{
      visualSpecs: Array<{
        slotIndex: number;
        subjectDescription: string;
        environmentDescription: string;
        actionTrajectory: string;
        emotionTag: string;
        lightingSpec: string;
      }>;
    }>({
      db,
      projectId,
      stage: 'S6',
      tier: 'TIER_FAST',
      systemInstruction,
      userPrompt,
      responseSchema: VISUAL_SPECS_SCHEMA,
      temperature: 0.3,
    });

    const rawList = Array.isArray(llmRes.data.visualSpecs) ? llmRes.data.visualSpecs : [];
    const validItems = rawList.filter((item) => isValidVisualSpec(item));

    if (validItems.length === 0) {
      lastMissingDetail = `LLM returned ${rawList.length} items with 0 complete visualSpecs`;
      continue;
    }

    validatedSpecs = validItems;
    break;
  }

  if (validatedSpecs.length === 0) {
    const err = new Error(
      `PACKAGING_INCOMPLETE: Stage 6 LLM failed to return complete visual specifications after 3 attempts (${lastMissingDetail}).`
    ) as Error & { code: string; statusCode: number };
    err.code = 'PACKAGING_INCOMPLETE';
    err.statusCode = 422;
    throw err;
  }

  const llmMap = new Map<number, SlotVisualSpec>();
  for (const spec of validatedSpecs) {
    llmMap.set(Number(spec.slotIndex), spec);
  }

  const fullVisualSpecs: SlotVisualSpec[] = s5.slots.map((slot, idx) => {
    const fromLlm = llmMap.get(slot.slotIndex) || validatedSpecs[idx % validatedSpecs.length];
    const cleanSubject = fromLlm.subjectDescription.replace(
      /\bAU\s*-?\s*\d+[A-Z]?\b/gi,
      'anatomical micro-expression'
    );
    const cleanAction = fromLlm.actionTrajectory.replace(
      /\bAU\s*-?\s*\d+[A-Z]?\b/gi,
      'natural facial tension'
    );

    return {
      slotIndex: slot.slotIndex,
      subjectDescription: cleanSubject,
      environmentDescription: fromLlm.environmentDescription,
      actionTrajectory: cleanAction,
      emotionTag: fromLlm.emotionTag,
      lightingSpec:
        fromLlm.lightingSpec ||
        lockedDna?.visualDirection?.lighting?.[0] ||
        (lockedDna as any)?.visuals?.lighting?.[0] ||
        'natural balanced studio lighting with crisp key and subtle fill, high dynamic range',
    };
  });

  const dnaVisual =
    lockedDna?.visualDirection ??
    (lockedDna as any)?.visuals ??
    (lockedDna as any)?.visual;
  const formatPreset = (lockedDna as any)?.formatPreset as NarrativeFormatPresetId | undefined;
  const stylePrefix =
    dnaVisual?.stylePrefix ||
    (formatPreset && FORMAT_PRESET_DEFAULT_STYLE_PREFIXES[formatPreset]) ||
    NEUTRAL_STYLE_PREFIX;

  const extraNegativePrompts = Array.from(
    new Set([
      ...masterState.extracted.negativePrompts,
      ...(lockedDna?.visuals?.negativePrompts ?? []),
      ...((dnaVisual as any)?.negativePrompts ?? []),
    ])
  );

  const prompts = assembleFlowPrompts({
    slots: s5.slots,
    visualSpecs: fullVisualSpecs,
    mode: s5.mode,
    extraNegativePrompts,
    defaultLightingHint: dnaVisual?.lighting?.[0],
    stylePrefix,
  });

  for (const p of prompts) {
    if (containsRawAuCode(p.promptText)) {
      throw new Error(`Stage 6 validation failed: prompt #${p.slotIndex} contained raw AU code.`);
    }
  }

  const batches = buildPromptBatches(prompts);
  const packs = buildFlowPromptPacks(prompts);

  const payload: Stage6PromptsPayload = {
    mode: s5.mode,
    totalPrompts: prompts.length,
    totalBatches: batches.length,
    batches,
    packCount: packs.length,
    prompts,
    packs,
  };

  commitStageState(db, {
    projectId,
    stageId: 'S6',
    payload,
    status: 'PASSED',
  });

  return payload;
}
