import { Type, type Schema } from '@google/genai';
import type { DatabaseSync } from 'node:sqlite';
import { UNIVERSAL_CREATOR_MODE_LABEL } from '../../src/config/constants.ts';
import { markDownstreamStagesDirty } from '../fsm/invalidation.ts';
import type { GeminiGateway } from '../llm/gemini.ts';

export interface ExtractedMasterPromptSettings {
  persona: string;
  customChapters: string[];
  brandName: string;
  negativePrompts: string[];
  toneWords: string[];
  bannedWords: string[];
}

export type MasterPromptExtraction = ExtractedMasterPromptSettings;

export interface MasterPromptState {
  text: string;
  isUniversalMode: boolean;
  modeLabel: string;
  extracted: ExtractedMasterPromptSettings;
}

export const EMPTY_MASTER_PROMPT_EXTRACTED: ExtractedMasterPromptSettings = {
  persona: '',
  customChapters: [],
  brandName: '',
  negativePrompts: [],
  toneWords: [],
  bannedWords: [],
};

const MASTER_PROMPT_EXTRACTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: [
    'persona',
    'customChapters',
    'brandName',
    'negativePrompts',
    'toneWords',
    'bannedWords',
  ],
  properties: {
    persona: { type: Type.STRING },
    customChapters: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    brandName: { type: Type.STRING },
    negativePrompts: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    toneWords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    bannedWords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
};

function normaliseExtracted(raw: Partial<ExtractedMasterPromptSettings> | null | undefined): ExtractedMasterPromptSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_MASTER_PROMPT_EXTRACTED };
  }
  return {
    persona: typeof raw.persona === 'string' ? raw.persona.trim() : '',
    customChapters: Array.isArray(raw.customChapters)
      ? raw.customChapters.map((c) => String(c).trim()).filter(Boolean)
      : [],
    brandName: typeof raw.brandName === 'string' ? raw.brandName.trim() : '',
    negativePrompts: Array.isArray(raw.negativePrompts)
      ? raw.negativePrompts.map((n) => String(n).trim()).filter(Boolean)
      : [],
    toneWords: Array.isArray(raw.toneWords)
      ? raw.toneWords.map((t) => String(t).trim()).filter(Boolean)
      : [],
    bannedWords: Array.isArray(raw.bannedWords)
      ? raw.bannedWords.map((b) => String(b).trim()).filter(Boolean)
      : [],
  };
}

export function getMasterPromptState(db: DatabaseSync, projectId: string): MasterPromptState {
  const row = db
    .prepare(
      `SELECT master_prompt, master_prompt_extracted_json FROM projects WHERE id = ?`
    )
    .get(projectId) as
    | {
        master_prompt: string | null;
        master_prompt_extracted_json: string | null;
      }
    | undefined;

  const text = (row?.master_prompt ?? '').trim();
  if (!text) {
    return {
      text: '',
      isUniversalMode: true,
      modeLabel: UNIVERSAL_CREATOR_MODE_LABEL,
      extracted: { ...EMPTY_MASTER_PROMPT_EXTRACTED },
    };
  }

  let parsed: Partial<ExtractedMasterPromptSettings> | null = null;
  if (row?.master_prompt_extracted_json) {
    try {
      parsed = JSON.parse(row.master_prompt_extracted_json) as Partial<ExtractedMasterPromptSettings>;
    } catch {
      parsed = null;
    }
  }

  return {
    text,
    isUniversalMode: false,
    modeLabel: 'Master Prompt Override Active',
    extracted: normaliseExtracted(parsed),
  };
}

export function buildMasterPromptInjectionBlock(
  db: DatabaseSync,
  projectId: string
): string {
  const state = getMasterPromptState(db, projectId);
  if (state.isUniversalMode) {
    return `[CREATOR_MODE: ${UNIVERSAL_CREATOR_MODE_LABEL}]`;
  }

  const lines: string[] = [
    `[MASTER_PROMPT_OVERRIDE_ACTIVE]`,
    `Raw Master Directive: ${state.text}`,
  ];
  if (state.extracted.persona) {
    lines.push(`Creator Persona: ${state.extracted.persona}`);
  }
  if (state.extracted.toneWords.length > 0) {
    lines.push(`Tone & Delivery Lexicon: ${state.extracted.toneWords.join(', ')}`);
  }
  if (state.extracted.brandName) {
    lines.push(`Brand Name Override: ${state.extracted.brandName}`);
  }
  if (state.extracted.customChapters.length > 0) {
    lines.push(`Custom Chapter Sequence: ${state.extracted.customChapters.join(' -> ')}`);
  }
  if (state.extracted.bannedWords.length > 0) {
    lines.push(`Master Prompt Banned Words: ${state.extracted.bannedWords.join(', ')}`);
  }
  if (state.extracted.negativePrompts.length > 0) {
    lines.push(`Visual Negative Directives: ${state.extracted.negativePrompts.join(', ')}`);
  }
  return lines.join('\n');
}

function cascadeMasterPromptDirtyIfDownstreamExists(
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

  const reason = 'Master prompt changed';
  // Mark S1 as dirty as well as S2..S7
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

export async function handleSaveMasterPrompt(params: {
  db: DatabaseSync;
  projectId: string;
  text: string;
  extractedOverride?: Partial<ExtractedMasterPromptSettings>;
  gemini: GeminiGateway;
}): Promise<{
  masterPrompt: MasterPromptState;
  dirtyStages: string[];
}> {
  const { db, projectId, text, extractedOverride, gemini } = params;
  const trimmed = String(text ?? '').trim();

  const prevRow = db
    .prepare(`SELECT master_prompt FROM projects WHERE id = ?`)
    .get(projectId) as { master_prompt: string | null } | undefined;

  if (!prevRow) {
    const err = new Error(`Project "${projectId}" not found.`) as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 404;
    err.code = 'PROJECT_NOT_FOUND';
    throw err;
  }

  const prevText = (prevRow.master_prompt ?? '').trim();
  const changed = prevText !== trimmed || Boolean(extractedOverride);

  // If cleared -> Universal Any-Niche Creator Mode
  if (!trimmed) {
    db.prepare(
      `UPDATE projects
       SET master_prompt = '',
           master_prompt_extracted_json = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(projectId);

    const dirtyStages = changed
      ? cascadeMasterPromptDirtyIfDownstreamExists(db, projectId)
      : [];

    return {
      masterPrompt: getMasterPromptState(db, projectId),
      dirtyStages,
    };
  }

  // Always persist raw text first so failure during extraction never loses user input
  db.prepare(
    `UPDATE projects
     SET master_prompt = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(trimmed, projectId);

  let extracted: ExtractedMasterPromptSettings;

  if (extractedOverride) {
    extracted = normaliseExtracted(extractedOverride);
  } else {
    try {
      const llmRes = await gemini.generateStructured<ExtractedMasterPromptSettings>({
        db,
        projectId,
        stage: 'S0_MASTER_PROMPT',
        tier: 'TIER_FAST',
        systemInstruction:
          'You are the Stage 0 Master Prompt Parser for ShowRunner OS. Extract structured creator persona, custom chapter titles (if any), brand name (if mentioned), visual negative prompts, tone words, and banned words/clichés from the user master prompt.',
        userPrompt: `Master Prompt Override Text:\n"""\n${trimmed}\n"""\n\nExtract the structured fields strictly matching the JSON schema.`,
        responseSchema: MASTER_PROMPT_EXTRACTION_SCHEMA,
        temperature: 0.1,
      });
      extracted = normaliseExtracted(llmRes.data);
    } catch (err) {
      if (changed) {
        cascadeMasterPromptDirtyIfDownstreamExists(db, projectId);
      }
      const wrapped = new Error(
        `Master prompt text was saved, but extraction failed: ${(err as Error)?.message || 'LLM error'}`
      ) as Error & { code?: string; statusCode?: number };
      wrapped.code = (err as { code?: string })?.code || 'MASTER_PROMPT_EXTRACTION_FAILED';
      wrapped.statusCode = (err as { statusCode?: number })?.statusCode || 422;
      throw wrapped;
    }
  }

  // If brandName was extracted, also update project.brand_name
  if (extracted.brandName) {
    db.prepare(
      `UPDATE projects
       SET master_prompt_extracted_json = ?,
           brand_name = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(JSON.stringify(extracted), extracted.brandName, projectId);
  } else {
    db.prepare(
      `UPDATE projects
       SET master_prompt_extracted_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(JSON.stringify(extracted), projectId);
  }

  const dirtyStages = changed
    ? cascadeMasterPromptDirtyIfDownstreamExists(db, projectId)
    : [];

  return {
    masterPrompt: getMasterPromptState(db, projectId),
    dirtyStages,
  };
}
