import { Type, type Schema } from '@google/genai';
import type { DatabaseSync } from 'node:sqlite';
import { UNIVERSAL_CREATOR_MODE_LABEL } from '../../src/config/constants.ts';
import {
  extractMasterPromptProfile,
  mergeProfileEnrichment,
  profileTargetMinutes,
  profileTargetWords,
  summariseProfile,
  type MasterPromptProfile,
} from '../../shared/rules/masterPromptProfile.ts';
import { markDownstreamStagesDirty } from '../fsm/invalidation.ts';
import type { GeminiGateway } from '../llm/gemini.ts';
import { handleLockChannelDna } from './s0bChannelDna.ts';

export interface ExtractedMasterPromptSettings {
  persona: string;
  customChapters: string[];
  brandName: string;
  negativePrompts: string[];
  toneWords: string[];
  bannedWords: string[];
  profile?: MasterPromptProfile;
  insertedBlacklistIds?: number[];
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
  insertedBlacklistIds: [],
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
    profile: raw.profile,
    insertedBlacklistIds: Array.isArray(raw.insertedBlacklistIds) ? raw.insertedBlacklistIds : [],
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

  if (state.extracted.profile) {
    lines.push('[MASTER_PROMPT_PARSED_RULES]');
    lines.push('CRITICAL INSTRUCTION: Every tool setting and rule has already been extracted from the creator\'s Master Prompt. Never ask the creator to re-enter any of these.');
    const summary = summariseProfile(state.extracted.profile);
    lines.push(`Summary: ${summary}`);
    lines.push(`Banned Words Count: ${state.extracted.profile.rules.bannedWords.length}`);
    lines.push(`Blacklist Count: ${state.extracted.profile.blacklist.length}`);
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

export function applyMasterPromptProfile(
  db: DatabaseSync,
  projectId: string,
  profile: MasterPromptProfile,
  previousExtracted?: Partial<ExtractedMasterPromptSettings> & { insertedBlacklistIds?: number[] }
): { insertedBlacklistIds: number[] } {
  const targetWords = profileTargetWords(profile);
  const targetDuration = profileTargetMinutes(profile);
  const brandName = profile.identity.spokenChannelName?.value || profile.identity.channelName?.value || '';
  const niche = profile.identity.niche?.value || '';
  const wpm = profile.budget.wpm?.value || null;
  const generationMode = profile.pacing.recommendedMode?.value || null;

  // 1. Update project fields
  db.prepare(
    `UPDATE projects
     SET niche = COALESCE(NULLIF(?, ''), niche),
         brand_name = COALESCE(NULLIF(?, ''), brand_name),
         configured_wpm = COALESCE(?, configured_wpm),
         target_words = ?,
         target_duration = ?,
         generation_mode = COALESCE(?, generation_mode),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(niche, brandName, wpm, targetWords, targetDuration, generationMode, projectId);

  // 2. Sync blacklist_catalog: remove prior inserted entries or duplicate titles
  if (
    Array.isArray(previousExtracted?.insertedBlacklistIds) &&
    previousExtracted.insertedBlacklistIds.length > 0
  ) {
    const placeholders = previousExtracted.insertedBlacklistIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM blacklist_catalog WHERE id IN (${placeholders}) AND project_id = ?`).run(
      ...previousExtracted.insertedBlacklistIds,
      projectId
    );
  }

  // Also remove existing entries by topic_title to prevent duplicates
  if (profile.blacklist.length > 0) {
    const titles = profile.blacklist.map((b) => b.title);
    const titlePlaceholders = titles.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM blacklist_catalog WHERE project_id = ? AND topic_title IN (${titlePlaceholders})`
    ).run(projectId, ...titles);
  }

  // Insert new blacklist entries
  const insertedBlacklistIds: number[] = [];
  const insertStmt = db.prepare(
    `INSERT INTO blacklist_catalog (project_id, topic_title, banned_anchor) VALUES (?, ?, ?)`
  );
  for (const item of profile.blacklist) {
    const anchor =
      item.coreAnchors && item.coreAnchors.length > 0
        ? item.coreAnchors.join(', ')
        : item.bannedDomain || '';
    const res = insertStmt.run(projectId, item.title, anchor);
    if (res.lastInsertRowid) {
      insertedBlacklistIds.push(Number(res.lastInsertRowid));
    }
  }

  // 3. Auto-lock Channel DNA with source: 'MASTER_PROMPT', fidelity 100
  const chapters =
    profile.chapters.length >= 2
      ? profile.chapters.map((c) => ({ name: c.name, sharePct: c.sharePct }))
      : [
          { name: 'Introduction', sharePct: 15 },
          { name: 'Core Narrative', sharePct: 70 },
          { name: 'Outro', sharePct: 15 },
        ];

  const primaryLang =
    profile.language.voiceoverLanguage.value === 'English'
      ? 'en'
      : 'hi';

  const script = profile.language.script.value || 'Devanagari';

  const dnaVisuals = {
    style: profile.visual.visualStyleLine.value || '16:9 widescreen aesthetic',
    stylePrefix: profile.visual.stylePrefix.value || undefined,
    palette: ['Deep obsidian', 'High-contrast clean vector', 'Accent gold'],
    lighting: ['High dynamic range clean studio key lighting'],
    cameraMotion: ['Controlled steady cinematic hold'],
    negativePrompts: profile.visual.negativePrompts || [],
  };

  const dnaVoice = {
    persona: profile.identity.persona.value || '',
    toneAxes: {
      seriousPlayful: 0.7,
      fastSlow: 0.65,
      simpleTechnical: 0.6,
      warmCold: 0.45,
    },
    wpm: wpm || 160,
    sentenceLen: [
      profile.budget.sentenceWordsMin.value || 8,
      profile.budget.sentenceWordsMax.value || 22,
    ] as [number, number],
    paragraphWords:
      profile.budget.wordsPerParagraph.value ||
      Math.round((profile.budget.wordBudgetMin.value + profile.budget.wordBudgetMax.value) / (profile.budget.paragraphMax.value || 16)) ||
      120,
    catchphrases: [],
    bannedWords: profile.rules.bannedWords,
    mustUsePhrases: profile.budget.ctaKeyword.value ? [profile.budget.ctaKeyword.value] : [],
  };

  const dnaStructure = {
    formatPreset: (profile.chapters.length >= 2 ? 'CUSTOM' : 'DOCUMENTARY') as 'CUSTOM' | 'DOCUMENTARY',
    chapters,
    hookStyle: 'High-retention opening anomaly statement followed by causal pivot',
    hookSeconds: profile.budget.hookSeconds.value || 15,
    reengageEverySec: [60, 90] as [number, number],
    ctaStyle: profile.budget.ctaKeyword.value
      ? `CTA keyword lock: ${profile.budget.ctaKeyword.value}`
      : 'Final synthesis payoff',
    durationRangeMin: [targetDuration, targetDuration] as [number, number],
  };

  const dnaPacing = {
    cutDurationSec: [
      profile.pacing.cutMinSec.value || 1.0,
      profile.pacing.cutMaxSec.value || 2.8,
    ] as [number, number],
    brollDensity: 'High visual change every sentence',
  };

  handleLockChannelDna({
    db,
    projectId,
    dna: {
      source: 'MASTER_PROMPT',
      fidelity: 100,
      identity: {
        niche: niche || 'YouTube Production',
        subNiche: profile.identity.editorialStrategy.value || '',
        pillars: profile.identity.editorialStrategy.value ? [profile.identity.editorialStrategy.value] : [],
        audiencePersona: profile.identity.audience.value || 'Curious inquisitive viewers',
        valueProp: profile.identity.editorialStrategy.value || '',
        differentiator: profile.visual.visualStyleLine.value || '',
      },
      language: {
        primary: primaryLang,
        script,
        codeSwitchRatio: profile.language.voiceoverLanguage.value === 'Hinglish' ? 0.35 : 0.05,
        formality: 0.7,
      },
      voice: dnaVoice,
      structure: dnaStructure,
      packaging: {
        titleFormulas: [
          'Why [Specific Entity] Actually [Unexpected Outcome]',
          'The [Number] Second Rule Behind [Phenomenon]',
          'How [Subject] Quietly Changed [Domain]',
        ],
        titleCharMax: 60,
        overlayRules: { maxWords: 3, style: 'Bold High-Contrast' },
        thumbnailStyle: {
          composition: 'Split-screen or dynamic focal character',
          palette: ['#0B0D10', '#00F0FF', '#F59E0B'],
          faceUsage: 'Expressive focal character',
          textPlacement: 'Top left corner safe zone',
        },
      },
      visuals: dnaVisuals,
      pacing: dnaPacing,
      performanceInsights: {
        outliers: [],
        doMore: ['Anchor every claim with a concrete number or primary source'],
        avoid: ['Slow generic introductions without an immediate anomaly'],
      },
      confidence: {
        identity: 'HIGH',
        language: 'HIGH',
        'voice.wpm': 'HIGH',
        structure: 'HIGH',
        packaging: 'HIGH',
        visuals: 'HIGH',
      },
      evidence: [],
      visualDirection: {
        aesthetic: profile.visual.visualStyleLine.value || '16:9 widescreen aesthetic',
        palette: dnaVisuals.palette,
        stylePrefix: profile.visual.stylePrefix.value || undefined,
        lighting: dnaVisuals.lighting,
        negativePrompts: profile.visual.negativePrompts || [],
      },
    },
  });

  return { insertedBlacklistIds };
}

export async function handleSaveMasterPrompt(params: {
  db: DatabaseSync;
  projectId: string;
  text: string;
  extractedOverride?: Partial<ExtractedMasterPromptSettings>;
  gemini?: GeminiGateway;
  skipLlmExtraction?: boolean;
}): Promise<{
  masterPrompt: MasterPromptState;
  dirtyStages: string[];
  extractionError?: string;
}> {
  const { db, projectId, text, extractedOverride, gemini, skipLlmExtraction = false } = params;
  const trimmed = String(text ?? '').trim();

  const prevRow = db
    .prepare(`SELECT master_prompt, master_prompt_extracted_json FROM projects WHERE id = ?`)
    .get(projectId) as
    | {
        master_prompt: string | null;
        master_prompt_extracted_json: string | null;
      }
    | undefined;

  if (!prevRow) {
    const err = new Error(`Project "${projectId}" not found.`) as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 404;
    err.code = 'PROJECT_NOT_FOUND';
    throw err;
  }

  let prevExtracted: (Partial<ExtractedMasterPromptSettings> & { insertedBlacklistIds?: number[] }) | null = null;
  if (prevRow.master_prompt_extracted_json) {
    try {
      prevExtracted = JSON.parse(prevRow.master_prompt_extracted_json);
    } catch {
      prevExtracted = null;
    }
  }

  const prevText = (prevRow.master_prompt ?? '').trim();
  const changed = prevText !== trimmed || Boolean(extractedOverride);

  // If cleared -> Universal Any-Niche Creator Mode
  if (!trimmed) {
    if (prevExtracted?.insertedBlacklistIds && prevExtracted.insertedBlacklistIds.length > 0) {
      const placeholders = prevExtracted.insertedBlacklistIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM blacklist_catalog WHERE id IN (${placeholders}) AND project_id = ?`).run(
        ...prevExtracted.insertedBlacklistIds,
        projectId
      );
    }

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

  // Step 2: Deterministic parser
  let profile = extractMasterPromptProfile(trimmed);
  let extractionError: string | undefined;

  // Step 3: Optional Gemini enrichment
  if (!skipLlmExtraction && gemini) {
    try {
      const llmRes = await gemini.generateStructured<Partial<ExtractedMasterPromptSettings>>({
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
      profile = mergeProfileEnrichment(profile, llmRes.data);
    } catch (err) {
      // Non-blocking: warning only!
      extractionError = (err as Error)?.message || 'LLM enrichment unavailable';
    }
  }

  // Step 4 & 5: Apply Master Prompt Profile (projects fields + blacklist_catalog sync + Channel DNA auto-lock)
  const { insertedBlacklistIds } = applyMasterPromptProfile(db, projectId, profile, prevExtracted ?? undefined);

  const brandName =
    extractedOverride?.brandName ||
    profile.identity.spokenChannelName?.value ||
    profile.identity.channelName?.value ||
    '';
  const customChapters =
    (extractedOverride?.customChapters && extractedOverride.customChapters.length > 0)
      ? extractedOverride.customChapters
      : profile.chapters.map((c) => c.name);
  const negativePrompts =
    (extractedOverride?.negativePrompts && extractedOverride.negativePrompts.length > 0)
      ? extractedOverride.negativePrompts
      : profile.visual.negativePrompts;
  const toneWords =
    (extractedOverride?.toneWords && extractedOverride.toneWords.length > 0)
      ? extractedOverride.toneWords
      : (profile.identity.editorialStrategy.value ? [profile.identity.editorialStrategy.value] : []);
  const bannedWords =
    (extractedOverride?.bannedWords && extractedOverride.bannedWords.length > 0)
      ? extractedOverride.bannedWords
      : profile.rules.bannedWords;

  const extractedToSave: ExtractedMasterPromptSettings = {
    persona: extractedOverride?.persona || profile.identity.persona.value,
    customChapters,
    brandName,
    negativePrompts,
    toneWords,
    bannedWords,
    profile,
    insertedBlacklistIds,
  };

  db.prepare(
    `UPDATE projects
     SET master_prompt_extracted_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(JSON.stringify(extractedToSave), projectId);

  // Step 6: cascade DIRTY only if text changed
  const dirtyStages = changed
    ? cascadeMasterPromptDirtyIfDownstreamExists(db, projectId)
    : [];

  return {
    masterPrompt: getMasterPromptState(db, projectId),
    dirtyStages,
    extractionError,
  };
}
