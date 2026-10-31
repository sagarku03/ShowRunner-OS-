import {
  REASONING_MODEL_PATTERNS,
  FAST_MODEL_PATTERNS,
  EMBEDDING_MODEL_PATTERNS,
   EXCLUDED_MODEL_PATTERNS,
} from '../../src/config/constants.ts';

export interface DiscoveredModel {
  id: string;
  name: string;
  displayName: string;
  tier: 'TIER_REASONING' | 'TIER_FAST' | 'TIER_EMBEDDING';
  supportedGenerationMethods: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export interface ModelDiscoveryResult {
  reasoningModels: DiscoveredModel[];
  fastModels: DiscoveredModel[];
  embeddingModels: DiscoveredModel[];
  recommendedReasoning: string | null;
  recommendedFast: string | null;
  recommendedEmbedding: string | null;
}

interface RawGeminiModelEntry {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

function rankByPatterns(modelId: string, patterns: ReadonlyArray<RegExp>): number {
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(modelId)) {
      return i;
    }
  }
  return patterns.length + 10;
}

/**
 * Classifies and ranks raw `/v1beta/models` entries into TIER_REASONING, TIER_FAST, and TIER_EMBEDDING.
 * Zero hard-coded model literals: uses configurable regex families from `src/config/constants.ts`.
 */
export function classifyDiscoveredModels(
  rawModels: ReadonlyArray<RawGeminiModelEntry>
): ModelDiscoveryResult {
  const reasoningModels: DiscoveredModel[] = [];
  const fastModels: DiscoveredModel[] = [];
  const embeddingModels: DiscoveredModel[] = [];

  for (const raw of rawModels) {
    const fullName = raw.name ?? '';
    const id = fullName.replace(/^models\//, '').trim();
    if (!id) continue;

    if (EXCLUDED_MODEL_PATTERNS.some((rx) => rx.test(id))) {
      continue;
    }

    const methods = Array.isArray(raw.supportedGenerationMethods)
      ? raw.supportedGenerationMethods
      : [];

    if (methods.includes('embedContent') || EMBEDDING_MODEL_PATTERNS.some((rx) => rx.test(id))) {
      embeddingModels.push({
        id,
        name: fullName,
        displayName: raw.displayName || id,
        tier: 'TIER_EMBEDDING',
        supportedGenerationMethods: methods,
        inputTokenLimit: raw.inputTokenLimit,
        outputTokenLimit: raw.outputTokenLimit,
      });
    }

    if (!methods.includes('generateContent')) {
      continue;
    }

    const isReasoning = REASONING_MODEL_PATTERNS.some((rx) => rx.test(id));
    const isFast = FAST_MODEL_PATTERNS.some((rx) => rx.test(id));

    if (isReasoning && !isFast) {
      reasoningModels.push({
        id,
        name: fullName,
        displayName: raw.displayName || id,
        tier: 'TIER_REASONING',
        supportedGenerationMethods: methods,
        inputTokenLimit: raw.inputTokenLimit,
        outputTokenLimit: raw.outputTokenLimit,
      });
    } else if (isFast) {
      fastModels.push({
        id,
        name: fullName,
        displayName: raw.displayName || id,
        tier: 'TIER_FAST',
        supportedGenerationMethods: methods,
        inputTokenLimit: raw.inputTokenLimit,
        outputTokenLimit: raw.outputTokenLimit,
      });
    } else {
      // Any other generateContent-capable Gemini model is added to fastModels as fallback candidate
      fastModels.push({
        id,
        name: fullName,
        displayName: raw.displayName || id,
        tier: 'TIER_FAST',
        supportedGenerationMethods: methods,
        inputTokenLimit: raw.inputTokenLimit,
        outputTokenLimit: raw.outputTokenLimit,
      });
    }
  }

  reasoningModels.sort(
    (a, b) =>
      rankByPatterns(a.id, REASONING_MODEL_PATTERNS) -
        rankByPatterns(b.id, REASONING_MODEL_PATTERNS) || b.id.localeCompare(a.id)
  );
  fastModels.sort(
    (a, b) =>
      rankByPatterns(a.id, FAST_MODEL_PATTERNS) - rankByPatterns(b.id, FAST_MODEL_PATTERNS) ||
      b.id.localeCompare(a.id)
  );
  embeddingModels.sort(
    (a, b) =>
      rankByPatterns(a.id, EMBEDDING_MODEL_PATTERNS) -
        rankByPatterns(b.id, EMBEDDING_MODEL_PATTERNS) || b.id.localeCompare(a.id)
  );

  return {
    reasoningModels,
    fastModels,
    embeddingModels,
    recommendedReasoning: reasoningModels[0]?.id ?? fastModels[0]?.id ?? null,
    recommendedFast: fastModels[0]?.id ?? reasoningModels[0]?.id ?? null,
    recommendedEmbedding: embeddingModels[0]?.id ?? null,
  };
}

/**
 * Fetches live models from `https://generativelanguage.googleapis.com/v1beta/models` using the provided API key.
 */
export async function fetchLiveGeminiModels(
  apiKey: string,
  customFetch: typeof fetch = fetch
): Promise<ModelDiscoveryResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    apiKey.trim()
  )}`;
  const response = await customFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const error = new Error(
      `Gemini model discovery failed with HTTP ${response.status}: ${errText.slice(0, 200)}`
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const data = (await response.json()) as { models?: RawGeminiModelEntry[] };
  return classifyDiscoveredModels(data.models ?? []);
}
