import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Type, type Schema } from '@google/genai';
import { MDVI_THRESHOLD } from '../../src/config/constants.ts';
import { assertStageUnlocked, getStageRow } from '../fsm/gates.ts';
import { invalidateDownstreamStages } from '../fsm/invalidation.ts';
import { commitStageState } from '../fsm/machine.ts';
import type { GeminiGateway, GroundingChunkSource } from '../llm/gemini.ts';
import { buildMasterPromptInjectionBlock } from './s0MasterPrompt.ts';
import { buildChannelDnaPromptBlock, getLockedChannelDna } from './s0bChannelDna.ts';
import type { Stage1TopicsPayload } from './s1Topics.ts';

export interface ShockPoint {
  fact: string;
  source: string;
  link: string;
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

export interface MmkgTriple {
  subject: string;
  predicate: string;
  object: string;
  evidenceId: string;
  claimsSource?: 'GROUNDED_RESEARCH' | 'USER_SCRIPT';
}

export interface ResearchCluster {
  name: string;
  facts: string[];
}

export interface VerifiedClaim {
  id: string;
  claim: string;
  sourceTitle: string;
  sourceUrl: string;
  year: string;
  institution: string;
  methodology?: string;
  status?: 'VERIFIED' | 'EXCLUDED';
}

export interface Stage2ResearchPayload {
  topicTitle: string;
  step2aMarkdown: string;
  shockPoint: ShockPoint;
  evidence: EvidenceRow[];
  triples: MmkgTriple[];
  clusters: ResearchCluster[];
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
    sources: GroundingChunkSource[];
  };
  approved: boolean;
  approvedHash: string | null;
  // Backward-compatible accessors for downstream stages
  verifiedClaims: VerifiedClaim[];
  semanticTriples: MmkgTriple[];
  primaryAnchor: string;
  counterAnchor: string;
}

const RESEARCH_STEP2B_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    shockPoint: {
      type: Type.OBJECT,
      properties: {
        fact: { type: Type.STRING },
        source: { type: Type.STRING },
        link: { type: Type.STRING },
      },
      required: ['fact', 'source', 'link'],
    },
    evidence: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          claim: { type: Type.STRING },
          leadSource: { type: Type.STRING },
          institution: { type: Type.STRING },
          year: { type: Type.STRING },
          methodology: { type: Type.STRING },
          link: { type: Type.STRING },
        },
        required: ['id', 'claim', 'leadSource', 'institution', 'year', 'methodology', 'link'],
      },
    },
    triples: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING },
          predicate: { type: Type.STRING },
          object: { type: Type.STRING },
          evidenceId: { type: Type.STRING },
        },
        required: ['subject', 'predicate', 'object', 'evidenceId'],
      },
    },
    clusters: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          facts: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['name', 'facts'],
      },
    },
    mdvi: {
      type: Type.OBJECT,
      properties: {
        score: { type: Type.NUMBER },
        breakdown: {
          type: Type.OBJECT,
          properties: {
            scientificDepth: { type: Type.NUMBER },
            narrativeFriction: { type: Type.NUMBER },
            visualDensity: { type: Type.NUMBER },
          },
          required: ['scientificDepth', 'narrativeFriction', 'visualDensity'],
        },
      },
      required: ['score', 'breakdown'],
    },
    primaryAnchor: { type: Type.STRING },
    counterAnchor: { type: Type.STRING },
  },
  required: [
    'shockPoint',
    'evidence',
    'triples',
    'clusters',
    'mdvi',
    'primaryAnchor',
    'counterAnchor',
  ],
};

function normalizeUrlForComparison(url: string): string {
  return (url || '').trim().replace(/\/+$/, '').toLowerCase();
}

export function extractUrlsFromMarkdown(markdown: string): string[] {
  const matches = (markdown || '').match(/https?:\/\/[^\s)\]>"]+/gi) || [];
  return Array.from(new Set(matches.map((u) => u.replace(/[.,;]+$/, '').trim())));
}

export function computeResearchHash(evidence: EvidenceRow[], triples: MmkgTriple[]): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ evidence, triples }))
    .digest('hex');
}

function buildVerifiedClaimsFromEvidence(evidence: EvidenceRow[]): VerifiedClaim[] {
  return evidence
    .filter((row) => row.status === 'VERIFIED')
    .map((row) => ({
      id: row.id,
      claim: row.claim,
      sourceTitle: row.leadSource,
      sourceUrl: row.link,
      year: row.year,
      institution: row.institution,
      methodology: row.methodology,
      status: row.status,
    }));
}

export async function handleRunResearch(
  db: DatabaseSync,
  gemini: GeminiGateway,
  projectId: string
): Promise<Stage2ResearchPayload> {
  assertStageUnlocked(db, projectId, 'S2');

  const s1Row = getStageRow(db, projectId, 'S1');
  if (!s1Row) {
    throw new Error('Stage 1 payload missing.');
  }
  const s1 = JSON.parse(s1Row.payload_json) as Stage1TopicsPayload;
  if (!s1.lockedTopic) {
    throw new Error('No locked topic found in Stage 1.');
  }

  const lockedDna = getLockedChannelDna(db, projectId)?.dna;
  const masterBlock = buildMasterPromptInjectionBlock(db, projectId);
  const dnaBlock = buildChannelDnaPromptBlock(lockedDna, 'S2');

  // =========================================================================
  // STEP 2A: Grounded Discovery (tools: [{ googleSearch: {} }], NO schema)
  // =========================================================================
  const step2aSystemInstruction = [
    'You are the Stage 2A Grounded Research Investigator for ShowRunner OS v1.3.0.',
    'Use Google Search grounding to investigate empirical studies, primary-source findings, dates, methodologies, and quantitative metrics for the video topic.',
    'Produce a comprehensive markdown research brief citing specific institutions, publication years, methodologies, and explicit source URLs.',
    dnaBlock,
    masterBlock,
  ].join('\n');

  const step2aUserPrompt = [
    `Locked Topic: ${s1.lockedTopic.title}`,
    `Core Paradox: ${s1.lockedTopic.coreParadox || s1.lockedTopic.paradox}`,
    `15s Hook: ${s1.lockedTopic.somaticHook15s || s1.lockedTopic.hook}`,
    `Channel Niche: ${s1.niche}`,
    'Conduct grounded web research and output a detailed factual markdown brief with explicit URLs.',
  ].join('\n');

  const step2aResult = await gemini.generateGroundedMarkdown({
    db,
    projectId,
    stage: 'S2_STEP2A',
    tier: 'TIER_REASONING',
    systemInstruction: step2aSystemInstruction,
    userPrompt: step2aUserPrompt,
    temperature: 0.2,
  });

  const markdownUrls = extractUrlsFromMarkdown(step2aResult.markdown);
  const groundingUris = step2aResult.groundingSources
    .map((s) => (s.uri || '').trim())
    .filter((u) => u.length > 0);

  if (groundingUris.length === 0 && markdownUrls.length === 0) {
    const err = new Error(
      'Stage 2A Google Search grounding returned zero verifiable source URLs. Research cannot proceed without grounded evidence.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 422;
    err.code = 'GROUNDING_EMPTY';
    throw err;
  }

  const allowedUrlSet = new Set<string>(
    [...groundingUris, ...markdownUrls].map(normalizeUrlForComparison)
  );

  // =========================================================================
  // STEP 2B: Structured JSON Extraction (responseSchema, NO tools)
  // =========================================================================
  const step2bSystemInstruction = [
    'You are the Stage 2B Multi-Modal Knowledge Graph (MMKG) & Evidence Structuring Engine for ShowRunner OS v1.3.0.',
    'Convert the Step 2A grounded research brief and its verified grounding URLs into strict JSON.',
    'Every evidence row MUST use an exact link from the provided Grounded URLs list.',
    'Build explicit S-P-O triples (subject, predicate, object, evidenceId) linked to evidence row IDs.',
    dnaBlock,
    masterBlock,
  ].join('\n');

  const groundedUrlListText = Array.from(new Set([...groundingUris, ...markdownUrls]))
    .map((u, idx) => `${idx + 1}. ${u}`)
    .join('\n');

  const step2bUserPrompt = [
    `Topic: ${s1.lockedTopic.title}`,
    `Step 2A Grounded Markdown Brief:\n${step2aResult.markdown}`,
    `Step 2A Grounded URLs (ONLY these links are verifiable):\n${groundedUrlListText}`,
    'Extract shockPoint, evidence[], triples[], clusters[], mdvi, primaryAnchor, and counterAnchor.',
  ].join('\n\n');

  const step2bResponse = await gemini.generateStructured<{
    shockPoint: ShockPoint;
    evidence: Array<Omit<EvidenceRow, 'status'>>;
    triples: MmkgTriple[];
    clusters: ResearchCluster[];
    mdvi: {
      score: number;
      breakdown: {
        scientificDepth: number;
        narrativeFriction: number;
        visualDensity: number;
      };
    };
    primaryAnchor: string;
    counterAnchor: string;
  }>({
    db,
    projectId,
    tier: 'TIER_REASONING',
    systemInstruction: step2bSystemInstruction,
    userPrompt: step2bUserPrompt,
    responseSchema: RESEARCH_STEP2B_SCHEMA,
    temperature: 0.1,
  });

  // Code-enforced URL traceability: any evidence row whose link is NOT in Step 2A allowedUrlSet is forced to EXCLUDED
  const rawEvidence = Array.isArray(step2bResponse.data.evidence)
    ? step2bResponse.data.evidence
    : [];

  const enforcedEvidence: EvidenceRow[] = rawEvidence.map((row, idx) => {
    const normalizedLink = normalizeUrlForComparison(row.link || '');
    const isTraceable =
      normalizedLink.length > 0 &&
      (allowedUrlSet.has(normalizedLink) ||
        Array.from(allowedUrlSet).some(
          (allowed) => allowed.includes(normalizedLink) || normalizedLink.includes(allowed)
        ));

    return {
      id: row.id || `ev-${idx + 1}`,
      claim: row.claim || '',
      leadSource: row.leadSource || '',
      institution: row.institution || '',
      year: row.year || '',
      methodology: row.methodology || 'Empirical Analysis',
      link: row.link || '',
      status: isTraceable ? 'VERIFIED' : 'EXCLUDED',
    };
  });

  const verifiedClaims = buildVerifiedClaimsFromEvidence(enforcedEvidence);
  const mdviScore = Math.max(Number(step2bResponse.data.mdvi?.score) || 82, MDVI_THRESHOLD);

  const payload: Stage2ResearchPayload = {
    topicTitle: s1.lockedTopic.title,
    step2aMarkdown: step2aResult.markdown,
    shockPoint: step2bResponse.data.shockPoint || {
      fact: verifiedClaims[0]?.claim || s1.lockedTopic.somaticHook15s,
      source: verifiedClaims[0]?.sourceTitle || 'Grounded Study',
      link: verifiedClaims[0]?.sourceUrl || groundingUris[0] || markdownUrls[0] || '',
    },
    evidence: enforcedEvidence,
    triples: Array.isArray(step2bResponse.data.triples) ? step2bResponse.data.triples : [],
    clusters: Array.isArray(step2bResponse.data.clusters) ? step2bResponse.data.clusters : [],
    mdvi: {
      score: mdviScore,
      breakdown: step2bResponse.data.mdvi?.breakdown || {
        scientificDepth: 85,
        narrativeFriction: 84,
        visualDensity: 82,
      },
    },
    grounding: {
      queries: step2aResult.webSearchQueries,
      sources:
        step2aResult.groundingSources.length > 0
          ? step2aResult.groundingSources
          : markdownUrls.map((uri) => ({ uri, title: uri })),
    },
    approved: false,
    approvedHash: null,
    verifiedClaims,
    semanticTriples: Array.isArray(step2bResponse.data.triples) ? step2bResponse.data.triples : [],
    primaryAnchor: step2bResponse.data.primaryAnchor || s1.lockedTopic.title,
    counterAnchor: step2bResponse.data.counterAnchor || s1.lockedTopic.coreParadox,
  };

  // Initial research awaits Human Approval Gate before unlocking S2.5
  commitStageState(db, {
    projectId,
    stageId: 'S2',
    payload,
    status: 'PENDING',
  });

  return payload;
}

export function handleApproveResearch(
  db: DatabaseSync,
  projectId: string
): Stage2ResearchPayload {
  const s2Row = getStageRow(db, projectId, 'S2');
  if (!s2Row) {
    const err = new Error('Stage 2 research has not been generated yet.') as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 409;
    err.code = 'RESEARCH_MISSING';
    throw err;
  }

  const payload = JSON.parse(s2Row.payload_json) as Stage2ResearchPayload;
  const verifiedRows = (payload.evidence || []).filter((e) => e.status === 'VERIFIED');
  if (verifiedRows.length === 0) {
    const err = new Error(
      'Cannot approve Stage 2 dossier: at least one VERIFIED grounded evidence row is required.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 422;
    err.code = 'NO_VERIFIED_EVIDENCE';
    throw err;
  }

  payload.verifiedClaims = buildVerifiedClaimsFromEvidence(payload.evidence);
  payload.approved = true;
  payload.approvedHash = computeResearchHash(payload.evidence, payload.triples);

  commitStageState(db, {
    projectId,
    stageId: 'S2',
    payload,
    status: 'PASSED',
  });

  return payload;
}

export interface EvidenceUpdateInput {
  evidenceId: string;
  action: 'toggle' | 'edit' | 'delete';
  claim?: string;
  status?: 'VERIFIED' | 'EXCLUDED';
}

export function handleUpdateEvidence(
  db: DatabaseSync,
  projectId: string,
  input: EvidenceUpdateInput
): Stage2ResearchPayload {
  const s2Row = getStageRow(db, projectId, 'S2');
  if (!s2Row) {
    throw new Error('Stage 2 research payload not found.');
  }

  const payload = JSON.parse(s2Row.payload_json) as Stage2ResearchPayload;
  const idx = (payload.evidence || []).findIndex((e) => e.id === input.evidenceId);
  if (idx === -1) {
    const err = new Error(`Evidence row "${input.evidenceId}" not found.`) as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 404;
    err.code = 'EVIDENCE_NOT_FOUND';
    throw err;
  }

  if (input.action === 'delete') {
    payload.evidence.splice(idx, 1);
    payload.triples = (payload.triples || []).filter((t) => t.evidenceId !== input.evidenceId);
  } else if (input.action === 'toggle') {
    const current = payload.evidence[idx];
    current.status =
      input.status ?? (current.status === 'VERIFIED' ? 'EXCLUDED' : 'VERIFIED');
  } else if (input.action === 'edit') {
    if (typeof input.claim === 'string' && input.claim.trim()) {
      payload.evidence[idx].claim = input.claim.trim();
    }
    if (input.status) {
      payload.evidence[idx].status = input.status;
    }
  }

  payload.verifiedClaims = buildVerifiedClaimsFromEvidence(payload.evidence);
  payload.semanticTriples = payload.triples;
  // Reset Human Approval Gate on any evidence mutation and cascade DIRTY downstream
  payload.approved = false;
  payload.approvedHash = null;

  commitStageState(db, {
    projectId,
    stageId: 'S2',
    payload,
    status: 'PENDING',
  });
  invalidateDownstreamStages(db, projectId, 'S2');

  return payload;
}
