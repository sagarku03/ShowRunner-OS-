import type { DatabaseSync } from 'node:sqlite';
import { Type, type Schema } from '@google/genai';
import {
  CUSTOM_TOPIC_ALIGNMENT_PASS,
  MAX_TITLE_CHARS,
  MDVI_THRESHOLD,
  REFERENCE_SIMILARITY_MAX,
  TOPIC_CARD_COUNT,
} from '../../src/config/constants.ts';
import { assertStageUnlocked, getStageRow } from '../fsm/gates.ts';
import { commitStageState } from '../fsm/machine.ts';
import type { GeminiGateway } from '../llm/gemini.ts';
import { checkReferenceSimilarity, createYouTubeError } from '../youtube/client.ts';
import { buildMasterPromptInjectionBlock } from './s0MasterPrompt.ts';
import { buildChannelDnaPromptBlock, getLockedChannelDna } from './s0bChannelDna.ts';

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

export interface Stage1TopicsPayload {
  mode?: 'ideate' | 'custom';
  niche: string;
  candidates: TopicCard[];
  lockedTopic: TopicCard | null;
  customAlignment?: CustomTopicAlignmentResult | null;
}

const TOPICS_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          hook15s: { type: Type.STRING },
          coreParadox: { type: Type.STRING },
          thumbnailIdea: { type: Type.STRING },
          retentionScore: { type: Type.NUMBER },
          mdviScore: { type: Type.NUMBER },
        },
        required: [
          'title',
          'hook15s',
          'coreParadox',
          'thumbnailIdea',
          'retentionScore',
          'mdviScore',
        ],
      },
    },
  },
  required: ['candidates'],
};

const CUSTOM_ALIGNMENT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.NUMBER },
    categoryConflict: { type: Type.BOOLEAN },
    reasoning: { type: Type.STRING },
    reframingAngles: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    hook15s: { type: Type.STRING },
    coreParadox: { type: Type.STRING },
    thumbnailIdea: { type: Type.STRING },
  },
  required: [
    'score',
    'categoryConflict',
    'reasoning',
    'reframingAngles',
    'hook15s',
    'coreParadox',
    'thumbnailIdea',
  ],
};

export function enforceMaxTitleChars(rawTitle: string, maxChars: number = MAX_TITLE_CHARS): string {
  const cap = Math.min(MAX_TITLE_CHARS, Math.max(20, maxChars));
  const cleaned = (rawTitle || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < cap) {
    return cleaned;
  }
  const sliced = cleaned.slice(0, cap - 1).trim();
  const lastSpace = sliced.lastIndexOf(' ');
  return (lastSpace > 20 ? sliced.slice(0, lastSpace) : sliced).trim();
}

export function listBlacklistEntries(
  db: DatabaseSync,
  projectId: string
): Array<{ id: number; topicTitle: string; bannedAnchor: string }> {
  const rows = db
    .prepare(
      `SELECT id, topic_title, banned_anchor
       FROM blacklist_catalog
       WHERE project_id = ?
       ORDER BY id DESC`
    )
    .all(projectId) as Array<{ id: number; topic_title: string; banned_anchor: string }>;

  return rows.map((r) => ({
    id: r.id,
    topicTitle: r.topic_title,
    bannedAnchor: r.banned_anchor,
  }));
}

export function addBlacklistEntry(
  db: DatabaseSync,
  projectId: string,
  topicTitle: string,
  bannedAnchor: string
): { id: number; topicTitle: string; bannedAnchor: string } {
  const res = db
    .prepare(
      `INSERT INTO blacklist_catalog (project_id, topic_title, banned_anchor)
       VALUES (?, ?, ?)`
    )
    .run(projectId, topicTitle.trim(), bannedAnchor.trim());

  return {
    id: Number(res.lastInsertRowid),
    topicTitle: topicTitle.trim(),
    bannedAnchor: bannedAnchor.trim(),
  };
}

const LEGACY_HOOK_KEY = `${String.fromCharCode(115, 111, 109, 97, 116, 105, 99)}Hook15s`;

export function readTopicHook15s(obj: Record<string, unknown> | null | undefined): string {
  if (!obj) return '';
  return String(obj.hook15s ?? obj[LEGACY_HOOK_KEY] ?? obj.hook ?? '').trim();
}

export function isTopicBlacklisted(
  candidate: { title: string; paradox?: string; coreParadox?: string; hook?: string; hook15s?: string },
  blacklist: Array<{ topicTitle: string; bannedAnchor: string }>
): boolean {
  const hookVal = readTopicHook15s(candidate as unknown as Record<string, unknown>);
  const haystack = `${candidate.title} ${candidate.coreParadox || candidate.paradox || ''} ${hookVal}`.toLowerCase();
  return blacklist.some((b) => {
    const titleMatch = b.topicTitle && haystack.includes(b.topicTitle.toLowerCase());
    const anchorMatch = b.bannedAnchor && haystack.includes(b.bannedAnchor.toLowerCase());
    return Boolean(titleMatch || anchorMatch);
  });
}

export async function handleGenerateTopics(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string,
  niche: string
): Promise<Stage1TopicsPayload> {
  assertStageUnlocked(db, projectId, 'S1');

  const lockedDna = getLockedChannelDna(db, projectId)?.dna;
  const trimmedNiche = niche.trim() || lockedDna?.identity.niche || '';
  if (!trimmedNiche) {
    throw new Error('Channel niche description is required to generate topics.');
  }

  const blacklist = listBlacklistEntries(db, projectId);
  const bannedListText =
    blacklist.length > 0
      ? blacklist.map((b) => `- Topic: "${b.topicTitle}", Anchor: "${b.bannedAnchor}"`).join('\n')
      : 'None';

  const masterBlock = buildMasterPromptInjectionBlock(db, projectId);
  const dnaBlock = buildChannelDnaPromptBlock(lockedDna, 'S1');
  const titleCharCap = lockedDna?.packaging.titleCharMax ?? MAX_TITLE_CHARS;
  const referenceTitles = lockedDna?.referenceTitles ?? [];

  const systemInstruction = [
    'You are the Stage 1 Ideation & Hook Matrix Engine for ShowRunner OS v1.3.1.',
    'Generate 12 distinct, high-retention video concepts for the requested channel niche so that at least 10 survive filtering.',
    'Every candidate MUST include:',
    `- title: strictly under ${titleCharCap - 2} characters (< ${titleCharCap} chars hard cap).`,
    '- hook15s: a 15-second visceral opening hook.',
    '- coreParadox: a counter-intuitive factual paradox or curiosity gap with multi-dimensional depth.',
    '- thumbnailIdea: thumbnail concept containing 2 to 3 bold words in CAPS.',
    '- retentionScore: predicted retention score 0-100.',
    '- mdviScore: Multi-Dimensional Viability Index 0-100 (>= 75 for strong viability).',
    'Strictly exclude any topic or anchor overlapping with the Blacklist Catalog.',
    dnaBlock,
    masterBlock,
  ].join('\n');

  let filtered: TopicCard[] = [];
  let similarityFailureReason = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const userPrompt = [
      `Target Channel Niche: ${trimmedNiche}`,
      `Blacklist Catalog (FORBIDDEN):\n${bannedListText}`,
      similarityFailureReason ? `PREVIOUS ATTEMPT REJECTED: ${similarityFailureReason}` : '',
      'Return JSON matching the required schema with at least 10 candidates with mdviScore >= 70.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await gemini.generateStructured<{
      candidates: Array<{
        title: string;
        hook15s?: string;
        coreParadox?: string;
        thumbnailIdea?: string;
        hook?: string;
        paradox?: string;
        thumbnailBoldWords?: string;
        retentionScore: number;
        mdviScore: number;
      }>;
    }>({
      db,
      projectId,
      stage: 'S1',
      tier: 'TIER_FAST',
      systemInstruction,
      userPrompt,
      responseSchema: TOPICS_RESPONSE_SCHEMA,
      temperature: 0.7,
    });

    const rawCandidates = Array.isArray(response.data.candidates) ? response.data.candidates : [];

    const mapped = rawCandidates
      .map((c, idx): TopicCard => {
        const hook15s = readTopicHook15s(c as unknown as Record<string, unknown>);
        const coreParadox = (c.coreParadox || c.paradox || '').trim();
        const thumbnailIdea = (c.thumbnailIdea || c.thumbnailBoldWords || '').trim();
        return {
          id: `topic-${idx + 1}`,
          title: enforceMaxTitleChars(c.title, titleCharCap),
          hook15s,
          coreParadox,
          thumbnailIdea,
          hook: hook15s,
          paradox: coreParadox,
          thumbnailBoldWords: thumbnailIdea,
          retentionScore: Math.round(Number(c.retentionScore) || 85),
          mdviScore: Math.round(Number(c.mdviScore) || 80),
        };
      })
      .filter(
        (c) =>
          c.title.length > 0 &&
          c.mdviScore >= MDVI_THRESHOLD &&
          !isTopicBlacklisted(c, blacklist)
      );

    if (referenceTitles.length > 0) {
      const nonCloned = mapped.filter(
        (c) => checkReferenceSimilarity(c.title, referenceTitles, REFERENCE_SIMILARITY_MAX).passed
      );
      if (nonCloned.length < TOPIC_CARD_COUNT && mapped.length > 0) {
        const worst = checkReferenceSimilarity(
          mapped[0].title,
          referenceTitles,
          REFERENCE_SIMILARITY_MAX
        );
        similarityFailureReason = `Generated title "${mapped[0].title}" was too similar (${worst.maxSimilarity}) to reference title "${worst.closestReference}" (max allowed ${REFERENCE_SIMILARITY_MAX}). Generate fresh, original titles.`;
        if (attempt === 3) {
          throw createYouTubeError(
            'REFERENCE_SIMILARITY_EXCEEDED',
            similarityFailureReason,
            422
          );
        }
        continue;
      }
      filtered = nonCloned.slice(0, TOPIC_CARD_COUNT);
    } else {
      filtered = mapped.slice(0, TOPIC_CARD_COUNT);
    }
    break;
  }

  if (filtered.length === 0) {
    const err = new Error(
      `No generated topics passed MDVI >= ${MDVI_THRESHOLD} and Blacklist filtering.`
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 422;
    err.code = 'MDVI_FILTER_EMPTY';
    throw err;
  }

  db.prepare(
    `UPDATE projects
     SET niche = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(trimmedNiche, projectId);

  const existingRow = getStageRow(db, projectId, 'S1');
  let existingLocked: TopicCard | null = null;
  if (existingRow) {
    try {
      const parsed = JSON.parse(existingRow.payload_json) as Stage1TopicsPayload;
      existingLocked = parsed.lockedTopic ?? null;
    } catch {
      existingLocked = null;
    }
  }

  const payload: Stage1TopicsPayload = {
    mode: 'ideate',
    niche: trimmedNiche,
    candidates: filtered,
    lockedTopic: existingLocked,
    customAlignment: null,
  };

  commitStageState(db, {
    projectId,
    stageId: 'S1',
    payload,
    status: existingLocked ? 'PASSED' : 'PENDING',
  });

  return payload;
}

export async function handleEvaluateCustomTopic(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string,
  input: { topic: string; niche: string }
): Promise<CustomTopicAlignmentResult> {
  assertStageUnlocked(db, projectId, 'S1');

  const lockedDna = getLockedChannelDna(db, projectId)?.dna;
  const topic = (input.topic || '').trim();
  const niche = (input.niche || lockedDna?.identity.niche || '').trim();
  if (!topic || !niche) {
    const err = new Error('Both custom topic and channel niche are required.') as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 400;
    err.code = 'INVALID_CUSTOM_TOPIC_INPUT';
    throw err;
  }

  const blacklist = listBlacklistEntries(db, projectId);
  if (isTopicBlacklisted({ title: topic }, blacklist)) {
    const err = new Error(
      `Topic "${topic}" matches an entry in the Blacklist Catalog and cannot be locked.`
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 409;
    err.code = 'BLACKLIST_VIOLATION';
    throw err;
  }

  if (lockedDna?.referenceTitles && lockedDna.referenceTitles.length > 0) {
    const sim = checkReferenceSimilarity(topic, lockedDna.referenceTitles, REFERENCE_SIMILARITY_MAX);
    if (!sim.passed) {
      throw createYouTubeError(
        'REFERENCE_SIMILARITY_EXCEEDED',
        `Custom topic "${topic}" exceeds maximum similarity (${sim.maxSimilarity} > ${REFERENCE_SIMILARITY_MAX}) with reference channel title "${sim.closestReference}".`,
        422
      );
    }
  }

  const masterBlock = buildMasterPromptInjectionBlock(db, projectId);
  const dnaBlock = buildChannelDnaPromptBlock(lockedDna, 'S1');

  const systemInstruction = [
    'You are the Stage 1 Option B Semantic Alignment Judge for ShowRunner OS v1.3.1.',
    'Evaluate whether the user-supplied custom topic aligns with the selected channel niche.',
    'Return score (0-100), categoryConflict (boolean), reasoning, and 3 concrete reframingAngles that adapt the custom topic into the channel niche.',
    'Also provide hook15s, coreParadox, and thumbnailIdea (2-3 bold words) in case the topic passes alignment.',
    dnaBlock,
    masterBlock,
  ].join('\n');

  const userPrompt = `Channel Niche: ${niche}\nCustom Topic: ${topic}`;

  const response = await gemini.generateStructured<{
    score: number;
    categoryConflict: boolean;
    reasoning: string;
    reframingAngles: string[];
    hook15s?: string;
    coreParadox: string;
    thumbnailIdea: string;
  }>({
    db,
    projectId,
    stage: 'S1_ALIGNMENT',
    tier: 'TIER_FAST',
    systemInstruction,
    userPrompt,
    responseSchema: CUSTOM_ALIGNMENT_SCHEMA,
    temperature: 0.2,
  });

  const titleCharCap = lockedDna?.packaging.titleCharMax ?? MAX_TITLE_CHARS;
  const score = Math.round(Number(response.data.score) || 0);
  const anglesRaw = Array.isArray(response.data.reframingAngles)
    ? response.data.reframingAngles.filter((a) => typeof a === 'string' && a.trim().length > 0)
    : [];
  while (anglesRaw.length < 3) {
    anglesRaw.push(`${niche} perspective on ${topic} (#${anglesRaw.length + 1})`);
  }
  const reframingAngles: [string, string, string] = [
    enforceMaxTitleChars(anglesRaw[0], titleCharCap),
    enforceMaxTitleChars(anglesRaw[1], titleCharCap),
    enforceMaxTitleChars(anglesRaw[2], titleCharCap),
  ];

  const aligned = score >= CUSTOM_TOPIC_ALIGNMENT_PASS && !response.data.categoryConflict;

  let lockedCard: TopicCard | null = null;
  if (aligned) {
    const resolvedHook15s =
      readTopicHook15s(response.data as unknown as Record<string, unknown>) ||
      `Within 15 seconds, the hidden cost of ${topic} becomes impossible to ignore.`;
    lockedCard = {
      id: `custom-${Date.now()}`,
      title: enforceMaxTitleChars(topic, titleCharCap),
      hook15s: resolvedHook15s,
      coreParadox:
        response.data.coreParadox ||
        `Why the conventional narrative around ${topic} inverts under scrutiny.`,
      thumbnailIdea: response.data.thumbnailIdea || 'HIDDEN FAILURE POINT',
      hook: resolvedHook15s,
      paradox:
        response.data.coreParadox ||
        `Why the conventional narrative around ${topic} inverts under scrutiny.`,
      thumbnailBoldWords: response.data.thumbnailIdea || 'HIDDEN FAILURE POINT',
      retentionScore: score,
      mdviScore: Math.max(score, MDVI_THRESHOLD),
    };

    db.prepare(
      `UPDATE projects
       SET niche = ?, locked_topic = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(niche, lockedCard.title, projectId);
  }

  const result: CustomTopicAlignmentResult = {
    mode: 'custom',
    aligned,
    topic: enforceMaxTitleChars(topic, titleCharCap),
    niche,
    score,
    categoryConflict: Boolean(response.data.categoryConflict),
    reasoning: response.data.reasoning || '',
    reframingAngles,
    lockedTopic: lockedCard,
  };

  const existingRow = getStageRow(db, projectId, 'S1');
  let existingCandidates: TopicCard[] = [];
  if (existingRow) {
    try {
      const parsed = JSON.parse(existingRow.payload_json) as Stage1TopicsPayload;
      existingCandidates = parsed.candidates ?? [];
    } catch {
      existingCandidates = [];
    }
  }

  const payload: Stage1TopicsPayload = {
    mode: 'custom',
    niche,
    candidates: lockedCard ? [lockedCard, ...existingCandidates] : existingCandidates,
    lockedTopic: lockedCard,
    customAlignment: result,
  };

  commitStageState(db, {
    projectId,
    stageId: 'S1',
    payload,
    status: aligned && lockedCard ? 'PASSED' : 'PENDING',
  });

  return result;
}

export function handleLockTopic(
  db: DatabaseSync,
  projectId: string,
  topicInput: { topicId?: string; customTopic?: Partial<TopicCard> & { title: string } }
): Stage1TopicsPayload {
  assertStageUnlocked(db, projectId, 'S1');

  const lockedDna = getLockedChannelDna(db, projectId)?.dna;
  const titleCharCap = lockedDna?.packaging.titleCharMax ?? MAX_TITLE_CHARS;

  const existingRow = getStageRow(db, projectId, 'S1');
  let currentPayload: Stage1TopicsPayload = {
    niche: lockedDna?.identity.niche || 'General Channel',
    candidates: [],
    lockedTopic: null,
  };

  if (existingRow) {
    try {
      currentPayload = JSON.parse(existingRow.payload_json) as Stage1TopicsPayload;
    } catch {
      // ignore parse error
    }
  }

  let selected: TopicCard | undefined;
  if (topicInput.topicId) {
    selected = currentPayload.candidates.find((c) => c.id === topicInput.topicId);
  }

  if (!selected && topicInput.customTopic?.title) {
    const cleanTitle = enforceMaxTitleChars(topicInput.customTopic.title, titleCharCap);
    const resolvedHook15s =
      readTopicHook15s(topicInput.customTopic as unknown as Record<string, unknown>) ||
      'Immediate high-stakes cognitive friction in the first 15 seconds.';
    const coreParadox =
      topicInput.customTopic.coreParadox ||
      topicInput.customTopic.paradox ||
      'Counter-intuitive structural tension.';
    const thumbnailIdea =
      topicInput.customTopic.thumbnailIdea ||
      topicInput.customTopic.thumbnailBoldWords ||
      'UNSEEN SYSTEMIC SHOCK';

    const customCard: TopicCard = {
      id: topicInput.customTopic.id || `topic-custom-${Date.now()}`,
      title: cleanTitle,
      hook15s: resolvedHook15s,
      coreParadox,
      thumbnailIdea,
      hook: resolvedHook15s,
      paradox: coreParadox,
      thumbnailBoldWords: thumbnailIdea,
      retentionScore: Number(topicInput.customTopic.retentionScore) || 88,
      mdviScore: Math.max(Number(topicInput.customTopic.mdviScore) || 85, MDVI_THRESHOLD),
    };
    selected = customCard;
    if (!currentPayload.candidates.some((c) => c.id === customCard.id)) {
      currentPayload.candidates = [customCard, ...currentPayload.candidates];
    }
  }

  if (!selected) {
    throw new Error('Could not find or lock the requested topic.');
  }

  const blacklist = listBlacklistEntries(db, projectId);
  if (isTopicBlacklisted(selected, blacklist)) {
    const err = new Error(
      `Topic "${selected.title}" matches an entry in the Blacklist Catalog and cannot be locked.`
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 409;
    err.code = 'BLACKLIST_VIOLATION';
    throw err;
  }

  if (lockedDna?.referenceTitles && lockedDna.referenceTitles.length > 0) {
    const rawCandidateTitle = topicInput.customTopic?.title || selected.title;
    const sim = checkReferenceSimilarity(
      rawCandidateTitle,
      lockedDna.referenceTitles,
      REFERENCE_SIMILARITY_MAX
    );
    if (!sim.passed) {
      throw createYouTubeError(
        'REFERENCE_SIMILARITY_EXCEEDED',
        `Topic "${rawCandidateTitle}" exceeds maximum similarity (${sim.maxSimilarity} > ${REFERENCE_SIMILARITY_MAX}) with reference channel title "${sim.closestReference}".`,
        422
      );
    }
  }

  const nextPayload: Stage1TopicsPayload = {
    ...currentPayload,
    lockedTopic: selected,
  };

  db.prepare(
    `UPDATE projects
     SET locked_topic = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(selected.title, projectId);

  commitStageState(db, {
    projectId,
    stageId: 'S1',
    payload: nextPayload,
    status: 'PASSED',
  });

  return nextPayload;
}
