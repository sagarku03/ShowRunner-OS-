import type { Schema } from '@google/genai';
import {
  resolveModelForProjectTier,
  type GeminiGateway,
  type GroundedMarkdownRequest,
  type GroundedMarkdownResponse,
  type StructuredGenerationRequest,
  type StructuredGenerationResponse,
} from '../../server/llm/gemini.ts';
import { normaliseEnglishSpoken } from '../../shared/rules/englishNumbers.ts';
import { normaliseSpoken } from '../../shared/rules/hindiNumbers.ts';
import { calculateWordBudget, splitWords } from '../../shared/rules/math.ts';

/**
 * Default offline mock fetch for unit/integration tests that do not supply a custom fetch.
 * Simulates Google Gemini `/v1beta/models` discovery and 1-token `:generateContent` live probe.
 */
export const defaultTestFetch: typeof fetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  if (url.includes('/v1beta/models') && (!init?.method || init.method === 'GET')) {
    return new Response(
      JSON.stringify({
        models: [
          {
            name: 'models/gemini-pro-latest',
            displayName: 'Gemini Pro Latest',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-flash-latest',
            displayName: 'Gemini Flash Latest',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-embedding-exp',
            displayName: 'Gemini Embedding Exp',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (url.includes(':generateContent')) {
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'OK' }] } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (url.includes('googleapis.com/youtube/v3/channels')) {
    return new Response(
      JSON.stringify({
        items: [{ id: 'UC_TEST_CHANNEL_01', snippet: { title: 'Test Channel' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

/**
 * Generates an indexed array of 17-point audit compliant Hindi paragraphs for testing.
 * Every paragraph starts with `, `, every sentence is strictly 14..22 words,
 * zero Arabic digits, pure Devanagari in spokenText, curiosity open loop in first 45s,
 * and brand name only in the final paragraph.
 */
export function buildCompliantHindiParagraphs(params?: {
  targetMinutes?: number;
  wpm?: number;
  brandName?: string;
}): Array<{
  id: number;
  phase: string;
  chapterTitle: string;
  text: string;
  spokenText: string;
  word_count: number;
}> {
  const targetMinutes = params?.targetMinutes ?? 11;
  const wpm = params?.wpm ?? 187.41;
  const brandName = params?.brandName ?? 'फ़ैक्टलॉक';

  const budget = calculateWordBudget(targetMinutes, wpm);
  const paraCount = budget.paragraphCount;
  const targetWordsPerPara = Math.round(budget.totalWords / paraCount);

  const hookSentence1 =
    'क्या आपने कभी सोचा है कि अंधेरी प्रयोगशाला में वैज्ञानिकों की धड़कन अचानक क्यों रुक जाती है?'; // 17 words
  const pivotSentence2 =
    'लेकिन विश्वविद्यालय के ताज़ा शोध ने हमारे पुराने वैज्ञानिक विश्वास को जड़ से पूरी तरह हिला दिया है।'; // 18 words
  const bodyPool = [
    'इसलिए तंत्रिका तंत्र के भीतर छिपे सूक्ष्म संकेतों को समझना हर शोधकर्ता के लिए बेहद ज़रूरी होता है।',
    'इसके बावजूद कोशिकाओं का यह जटिल चक्र बिना रुके चौबीस घंटे पूरी सटीकता के साथ काम करता है।',
    'परिणामस्वरूप जब हम मस्तिष्क की गहराई में झाँकते हैं तो चौंकाने वाले जैविक तथ्य स्पष्ट दिखाई देते हैं?',
    'क्योंकि हर सेकंड लाखों विद्युत तरंगें हमारे शरीर के तापमान और रक्तचाप को चुपचाप नियंत्रित करती रहती हैं।',
    'उदाहरण के लिए गहरे समुद्र के दबाव की तरह यह मानसिक तनाव धीरे धीरे भीतर बढ़ता जाता है।',
    'यही कारण है कि आधुनिक चिकित्सा विज्ञान इस अनोखी शारीरिक प्रक्रिया को एक बड़ी पहेली मानता आया है?',
  ];

  const paragraphs: Array<{
    id: number;
    phase: string;
    chapterTitle: string;
    text: string;
    spokenText: string;
    word_count: number;
  }> = [];

  for (let i = 0; i < paraCount; i++) {
    const isLast = i === paraCount - 1;
    const sentences: string[] = [];

    if (i === 0) {
      sentences.push(hookSentence1);
      sentences.push(pivotSentence2);
    }

    let poolIdx = i;
    while (splitWords(sentences.join(' ')).length + 18 < targetWordsPerPara - 9) {
      sentences.push(bodyPool[poolIdx % bodyPool.length]);
      poolIdx += 1;
    }

    if (isLast) {
      const payoffBrand = cleanBrandForDevanagari(brandName);
      sentences.push(
        `अंततः यह वैज्ञानिक सत्य हमें बिल्कुल नई दिशा दिखाता है और ${payoffBrand} की इस पड़ताल को पूरा करता है।`
      );
    } else {
      sentences.push(bodyPool[(i + 2) % bodyPool.length]);
    }

    const joined = `, ${sentences.join(' ')}`;
    const spoken = normaliseSpoken(joined.replace(/[A-Za-z]+/g, 'फ़ैक्टलॉक'), 'Devanagari');
    const finalBox1 =
      isLast && /[A-Za-z]/.test(brandName)
        ? joined.replace('फ़ैक्टलॉक', brandName)
        : joined;

    paragraphs.push({
      id: i,
      phase: budget.phases[i % budget.phases.length].phaseName,
      chapterTitle: `अध्याय ${ekToWord(i + 1)}: वैज्ञानिक रहस्य`,
      text: finalBox1,
      spokenText: spoken,
      word_count: splitWords(finalBox1).length,
    });
  }

  return paragraphs;
}

/**
 * Generates an indexed array of 17-point audit compliant English (Latin script) paragraphs for testing.
 * Every paragraph starts with `, `, every sentence is within [12, 24] words,
 * zero Arabic digits, pure Latin script in spokenText, curiosity open loop in first 45s,
 * causal transitions ("therefore", "however", "because", "consequently"),
 * and brand name only in the final paragraph.
 */
export function buildCompliantEnglishParagraphs(params?: {
  targetMinutes?: number;
  wpm?: number;
  brandName?: string;
}): Array<{
  id: number;
  phase: string;
  chapterTitle: string;
  text: string;
  spokenText: string;
  word_count: number;
}> {
  const targetMinutes = params?.targetMinutes ?? 11;
  const wpm = params?.wpm ?? 160;
  const brandName = params?.brandName ?? 'CreatorPulse';

  const budget = calculateWordBudget(targetMinutes, wpm);
  const paraCount = budget.paragraphCount;
  const targetWordsPerPara = Math.round(budget.totalWords / paraCount);

  // Every sentence below has 16..18 words
  const hookSentence1 =
    'Have you ever wondered why early graphics processors suddenly failed during intense thermal laboratory stress tests?'; // 16 words, has '?' and 'why'
  const pivotSentence2 =
    'However recent silicon microarchitecture experiments completely shattered every assumption engineers held about voltage stability indoors.'; // 16 words
  const bodyPool = [
    'Therefore understanding microscopic transistor leakage currents remains critical for every hardware architect designing modern computing systems.', // 16 words
    'Nevertheless thermal dissipation pathways across copper heatspreaders operate continuously without pause during heavy rendering workloads.', // 16 words
    'Consequently when engineers inspect silicon wafers under electron microscopes surprising structural anomalies appear near memory controllers?', // 16 words (with ?)
    'Because millions of synchronized clock gates regulate core voltage levels quietly across every single processing cluster.', // 16 words
    'Furthermore subtle electromagnetic interference inside dense circuit boards gradually degrades signal integrity over extended operating cycles.', // 16 words
    'Therefore modern semiconductor fabrication laboratories treat nanoscale lithography alignment as their most demanding engineering puzzle today?', // 16 words (with ?)
  ];

  const paragraphs: Array<{
    id: number;
    phase: string;
    chapterTitle: string;
    text: string;
    spokenText: string;
    word_count: number;
  }> = [];

  for (let i = 0; i < paraCount; i++) {
    const isLast = i === paraCount - 1;
    const sentences: string[] = [];

    if (i === 0) {
      sentences.push(hookSentence1);
      sentences.push(pivotSentence2);
    }

    let poolIdx = i;
    while (splitWords(sentences.join(' ')).length + 16 < targetWordsPerPara - 8) {
      sentences.push(bodyPool[poolIdx % bodyPool.length]);
      poolIdx += 1;
    }

    if (isLast) {
      sentences.push(
        `Therefore these empirical silicon measurements reveal a clear architectural path and conclude this ${brandName} investigation today.`
      );
    } else {
      sentences.push(bodyPool[(i + 2) % bodyPool.length]);
    }

    const joined = `, ${sentences.join(' ')}`;
    const spoken = normaliseEnglishSpoken(joined);

    paragraphs.push({
      id: i,
      phase: budget.phases[i % budget.phases.length].phaseName,
      chapterTitle: `Chapter ${englishWordIndex(i + 1)}: Silicon Architecture`,
      text: joined,
      spokenText: spoken,
      word_count: splitWords(joined).length,
    });
  }

  return paragraphs;
}

function englishWordIndex(n: number): string {
  const words = [
    'Zero',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
  ];
  return words[n] || 'Special';
}

function cleanBrandForDevanagari(brand: string): string {
  if (!/[A-Za-z]/.test(brand)) return brand;
  return 'फ़ैक्टलॉक';
}

function ekToWord(n: number): string {
  const words = [
    'शून्य',
    'एक',
    'दो',
    'तीन',
    'चार',
    'पाँच',
    'छह',
    'सात',
    'आठ',
    'नौ',
    'दस',
    'ग्यारह',
    'बारह',
    'तेरह',
    'चौदह',
    'पंद्रह',
  ];
  return words[n] || 'विशेष';
}

export interface FakeGeminiOptions {
  targetMinutes?: number;
  wpm?: number;
  brandName?: string;
  customAlignmentScore?: number;
  groundingEmpty?: boolean;
  judgeThrows?: boolean;
  repairAlwaysFails?: boolean;
  emriFail?: boolean;
  /** Number of times S7 packaging returns < 3 variants before succeeding (or always if >= 3) */
  s7IncompleteTimes?: number;
  /** Number of times S6 visual prompts returns missing fields before succeeding */
  s6IncompleteTimes?: number;
  /** Titles to emit in Stage 1 to test Reference Channel similarity guard */
  s1CustomCandidateTitles?: string[];
}

export class FakeGeminiGateway implements GeminiGateway {
  public readonly isFake = true;
  public options: FakeGeminiOptions;
  public groundedCalls: Array<GroundedMarkdownRequest & { hasResponseSchema: boolean }> = [];
  public structuredCalls: Array<
    StructuredGenerationRequest<Schema> & { hasTools: boolean }
  > = [];
  public embedCalls: string[][] = [];
  private s7CallCount = 0;
  private s6CallCount = 0;
  private s1CallCount = 0;

  constructor(options?: FakeGeminiOptions) {
    this.options = options ?? {};
  }

  async generateGroundedMarkdown(
    req: GroundedMarkdownRequest
  ): Promise<GroundedMarkdownResponse> {
    if (req.db && req.projectId) {
      resolveModelForProjectTier(req.db, req.projectId, req.tier);
    }
    this.groundedCalls.push({
      ...req,
      hasResponseSchema: 'responseSchema' in (req as unknown as Record<string, unknown>),
    });

    if (this.options.groundingEmpty) {
      return {
        markdown: 'No external sources found.',
        modelUsed: 'models/gemini-pro-latest',
        keyIdUsed: 1,
        webSearchQueries: ['chronobiology suprachiasmatic nucleus study'],
        groundingSources: [],
      };
    }

    if (req.stage === 'S0B_NICHE_SEARCH' || req.stage === 'S0B') {
      return {
        markdown: [
          '# Grounded Niche Intelligence Brief',
          'Top performing channels in this niche use high-contrast curiosity hooks, 155-185 WPM pacing, and structured 6-7 beat narrative arcs (https://youtube.com/creators-research-2025).',
          'Audience retention benchmarks show strong response to concrete numerical case studies and visual metaphor anchors (https://stanford.edu/media-retention-2024).',
        ].join('\n\n'),
        modelUsed: 'models/gemini-pro-latest',
        keyIdUsed: 1,
        webSearchQueries: [
          'top youtube channels niche retention format analysis',
          'audience engagement pacing benchmarks 2025',
        ],
        groundingSources: [
          {
            uri: 'https://youtube.com/creators-research-2025',
            title: 'YouTube Creator Format Benchmarks (2025)',
          },
          {
            uri: 'https://stanford.edu/media-retention-2024',
            title: 'Stanford Media Retention Study (2024)',
          },
        ],
      };
    }

    return {
      markdown: [
        '# Grounded Research Dossier: Circadian Neural Oscillations',
        'Peer-reviewed findings from Stanford Sleep Lab (2024) demonstrate a 24% metabolic drop at 03:17 AM (https://stanford.edu/chronobiology-2024).',
        'Harvard Medical School (2023) confirmed suprachiasmatic nucleus phase-locking under dark-cycle deprivation (https://hms.harvard.edu/scn-phase-2023).',
      ].join('\n\n'),
      modelUsed: 'models/gemini-pro-latest',
      keyIdUsed: 1,
      webSearchQueries: [
        'suprachiasmatic nucleus circadian phase locking study',
        'stanford chronobiology metabolic drop 2024',
      ],
      groundingSources: [
        {
          uri: 'https://stanford.edu/chronobiology-2024',
          title: 'Stanford Chronobiology Metabolic Study (2024)',
        },
        {
          uri: 'https://hms.harvard.edu/scn-phase-2023',
          title: 'Harvard SCN Phase Locking Analysis (2023)',
        },
      ],
    };
  }

  async generateStructured<T>(
    req: StructuredGenerationRequest<Schema>
  ): Promise<StructuredGenerationResponse<T>> {
    if (req.db && req.projectId) {
      resolveModelForProjectTier(req.db, req.projectId, req.tier);
    }
    this.structuredCalls.push({
      ...req,
      hasTools: 'tools' in (req as unknown as Record<string, unknown>),
    });

    const sys = req.systemInstruction;

    // Stage 0: Master Prompt Override Extraction
    if (
      req.stage === 'S0_MASTER_PROMPT' ||
      sys.includes('Stage 0 Master Prompt Parser') ||
      sys.includes('Stage 0 Master Prompt Override Extractor')
    ) {
      const promptText = req.userPrompt;
      const customChaptersMatch = promptText.match(/chapters?:\s*([^\n]+)/i);
      const customChapters = customChaptersMatch
        ? customChaptersMatch[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : ['The Setup', 'The Hidden Mechanism', 'The Payoff'];
      const brandMatch = promptText.match(/brand(?:\s*name)?:\s*([A-Za-z0-9_-]+)/i);
      const data = {
        persona: 'Sharp investigative storyteller with high empirical clarity',
        customChapters,
        brandName: brandMatch ? brandMatch[1] : 'PulseLock',
        negativePrompts: ['neon cyberpunk clutter', 'cartoonish clipart'],
        toneWords: ['analytical', 'urgent', 'visceral'],
        bannedWords: ['synergy', 'paradigm'],
      };
      return {
        data: data as unknown as T,
        rawText: JSON.stringify(data),
        modelUsed: 'models/gemini-flash-latest',
        keyIdUsed: 1,
      };
    }

    // Stage S0B Path A: Qualitative Channel DNA Extraction
    if (
      req.stage === 'S0B_ANALYSE_CHANNEL' ||
      sys.includes('Stage S0B Channel DNA Forensic Analyst')
    ) {
      const idMatches = Array.from(req.userPrompt.matchAll(/videoId="([^"]+)"/g)).map(
        (m) => m[1]
      );
      const firstId = idMatches[0] ?? 'vid-1';
      const secondId = idMatches[1] ?? firstId;

      const data = {
        identity: {
          niche: 'Deep-Dive Technology & Science Analysis',
          subNiche: 'Systems Engineering & Empirical Case Studies',
          pillars: ['Core Mechanism Breakdown', 'Empirical Case Studies', 'Systemic Paradoxes'],
          audiencePersona: 'Curious viewers who want rigorous explanations without academic jargon',
          valueProp: 'Revealing the hidden mechanisms behind everyday systems with primary evidence.',
          differentiator: 'Primary-source evidence paired with macro forensic visualization',
        },
        language: {
          primary: 'hi',
          script: 'Devanagari',
          codeSwitchRatio: 0.15,
          formality: 0.65,
        },
        voice: {
          persona: 'Conversational investigative narrator with sharp pacing',
          toneAxes: {
            seriousPlayful: 0.25,
            fastSlow: 0.7,
            simpleTechnical: 0.6,
            warmCold: 0.4,
          },
          catchphrases: ['चलिए इसके पीछे के असली विज्ञान को समझते हैं'],
          bannedWords: ['delve', 'tapestry'],
          mustUsePhrases: [],
        },
        structure: {
          formatPreset: 'DOCUMENTARY',
          hookStyle: 'Immediate empirical anomaly followed by a 15s causal pivot',
          hookSeconds: 15,
          ctaStyle: 'Final synthesis payoff tied to the opening anomaly',
        },
        packaging: {
          titleFormulas: [
            'Why [System] Fails at [Threshold]',
            'The Hidden [Mechanism] Inside [Object]',
          ],
          overlayStyle: '2-3 bold high-contrast words with zero title overlap',
          thumbnailComposition: 'High-contrast foreground subject with bottom-right 20% clear',
          thumbnailPalette: ['#090A0F', '#00F0FF', '#F59E0B'],
          faceUsage: 'Expressive anatomical micro-tension (AU1+AU4)',
        },
        visuals: {
          style: '16:9 widescreen forensic macro cinematography',
          palette: ['obsidian', 'cyan', 'amber', 'tungsten'],
          lighting: ['Chiaroscuro rim lighting with volumetric haze'],
          cameraMotion: ['35mm slow dolly-in', 'Macro rack focus'],
          negativePrompts: ['oversaturated cartoon', 'clipart'],
        },
        pacing: {
          cutDurationSec: [4.5, 7.5],
          brollDensity: 'High visual change every sentence',
        },
        outlierReasons: [
          {
            videoId: firstId,
            whyItWorked: 'Counter-intuitive numeric anomaly in title and first 15s hook',
            evidenceQuoteOrTimestamp: '00:00 - Why Systems Fail',
          },
        ],
        claims: [
          {
            field: 'packaging.titleFormulas',
            claim: 'Uses counter-intuitive "Why [System] Fails" curiosity hooks',
            confidence: 'HIGH',
            evidence: [{ videoId: firstId, quoteOrTimestamp: 'Title: Why Systems Fail' }],
          },
          {
            field: 'structure.hookStyle',
            claim: 'Opens with an immediate empirical anomaly in the first 15 seconds',
            confidence: 'HIGH',
            evidence: [{ videoId: secondId, quoteOrTimestamp: '00:05 transcript opening' }],
          },
          {
            // Un-evidenced claim that MUST be dropped by filterClaimsRequiringEvidence (T10)
            field: 'voice.persona',
            claim: 'Unverified Hallucinated Claim Without Evidence',
            confidence: 'LOW',
            evidence: [],
          },
        ],
      };
      return {
        data: data as unknown as T,
        rawText: JSON.stringify(data),
        modelUsed: 'models/gemini-pro-latest',
        keyIdUsed: 1,
      };
    }

    // Thumbnail Vision Inspection (E10)
    if (
      req.stage === 'THUMBNAIL_VISION' ||
      sys.includes('Thumbnail Vision') ||
      req.userPrompt.includes('thumbnail image')
    ) {
      if ((req as any).inlineData) {
        const data = {
          composition: 'Split-screen high contrast with primary subject on left',
          facePresent: true,
          faceExpression: 'Intense analytical focus with furrowed brow (AU4)',
          dominantColors: ['#0B0D10', '#00F0FF', '#F59E0B'],
          textOverlayOcr: 'WHY IT BROKE',
          confidence: 'HIGH',
        };
        return {
          data: data as unknown as T,
          rawText: JSON.stringify(data),
          modelUsed: 'models/gemini-flash-latest',
          keyIdUsed: 1,
        };
      }
      const fallbackData = {
        composition: 'UNKNOWN',
        facePresent: false,
        faceExpression: 'UNKNOWN',
        dominantColors: [],
        textOverlayOcr: '',
        confidence: 'LOW',
      };
      return {
        data: fallbackData as unknown as T,
        rawText: JSON.stringify(fallbackData),
        modelUsed: 'models/gemini-flash-latest',
        keyIdUsed: 1,
      };
    }

    // Stage S0B Path B: Niche Synthesis (3 Style Options)
    if (
      req.stage === 'S0B_NICHE_SYNTHESIS' ||
      sys.includes('Convert the grounded Niche Intelligence dossier into 3 distinct')
    ) {
      const data = {
        topPatterns: [
          'Counter-intuitive numerical hooks in first 15 seconds',
          'High-contrast 2-3 word thumbnail overlays',
        ],
        contentGaps: [
          'Primary-source visual breakdowns without academic jargon',
          'Concrete real-world case study comparisons',
        ],
        audiencePainPoints: [
          'Surface-level clickbait without actionable mechanisms',
          'Slow generic introductions',
        ],
        options: [
          {
            optionId: 'STYLE_A',
            label: 'Option A — Forensic Investigative Documentary',
            tagline: 'Deep-dive investigative storytelling anchored by primary data.',
            whyItWins: 'Commands high authority and session watch time.',
            persona: 'Sharp investigative documentary narrator',
            formatPreset: 'DOCUMENTARY',
            hookStyle: 'Counter-intuitive anomaly statement followed by a 15s causal pivot',
            titleFormulas: [
              'Why [Specific Mechanism] Quietly Controls [Outcome]',
              'The Hidden Truth Behind [Phenomenon]',
            ],
            visualStyle: '16:9 widescreen chiaroscuro forensic realism',
            palette: ['#090A0F', '#00F0FF', '#F59E0B'],
            lighting: ['Chiaroscuro key lighting with cyan rim'],
            pillars: ['Core Mechanisms', 'Forensic Case Studies', 'Systemic Paradoxes'],
            differentiator: 'Primary-source evidence with visceral visual metaphors',
          },
          {
            optionId: 'STYLE_B',
            label: 'Option B — High-Velocity Visual Explainer',
            tagline: 'Fast, crisp structured explanations with kinetic visual metaphors.',
            whyItWins: 'Maximizes completion rate for busy viewers.',
            persona: 'Energetic, crystal-clear systems explainer',
            formatPreset: 'EXPLAINER',
            hookStyle: 'Direct relatable problem followed by surprising math',
            titleFormulas: [
              'How [System] Actually Works in [Timeframe]',
              'The [Number] Rules of [Topic]',
            ],
            visualStyle: '16:9 clean studio macro & kinetic diagram aesthetic',
            palette: ['#0F172A', '#10B981', '#F8FAFC'],
            lighting: ['Crisp studio key lighting with emerald accent'],
            pillars: ['Step-by-Step Breakdowns', 'Mental Models', 'Applied Systems'],
            differentiator: 'Zero-fluff visual clarity in under 12 minutes',
          },
          {
            optionId: 'STYLE_C',
            label: 'Option C — Narrative Case-Study Storytime',
            tagline: 'Character-driven real-world case studies with high emotional stakes.',
            whyItWins: 'Builds strong parasocial connection and high shareability.',
            persona: 'Warm, gripping narrative storyteller',
            formatPreset: 'STORYTIME',
            hookStyle: 'In-media-res turning point moment',
            titleFormulas: [
              'How One [Decision] Changed [Domain] Forever',
              'The Rise and Fall of [Case Study]',
            ],
            visualStyle: '16:9 warm tungsten cinematic storytelling',
            palette: ['#18181B', '#F97316', '#FEF3C7'],
            lighting: ['Warm tungsten key light with atmospheric depth'],
            pillars: ['Turning Point Stories', 'Human Stakes', 'Lessons Learned'],
            differentiator: 'Cinematic narrative arcs grounded in real events',
          },
        ],
      };

      return {
        data: data as unknown as T,
        rawText: JSON.stringify(data),
        modelUsed: 'models/gemini-flash-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 1 Option A: 10 Topic Cards
    if (sys.includes('Stage 1 Ideation & Hook Matrix Engine')) {
      this.s1CallCount += 1;
      const customTitles = this.options.s1CustomCandidateTitles;
      const candidates = Array.from({ length: 12 }, (_, idx) => ({
        title:
          customTitles && idx < customTitles.length
            ? customTitles[idx]
            : `The Neural Clock Paradox #${idx + 1}: Hidden Midnight Signal`,
        hook15s: `At 03:17 AM your core body temperature drops while cortisol spikes (${idx + 1}).`,
        somaticHook15s: `At 03:17 AM your core body temperature drops while cortisol spikes (${idx + 1}).`,
        coreParadox: `Why sleeping longer can accelerate neural fatigue in phase ${idx + 1}.`,
        thumbnailIdea: `MIDNIGHT PULSE`,
        retentionScore: 92 - (idx % 5),
        mdviScore: 88 - (idx % 6),
      }));
      return {
        data: { candidates } as unknown as T,
        rawText: JSON.stringify({ candidates }),
        modelUsed: 'models/gemini-flash-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 1 Option B: Custom Topic Semantic Alignment
    if (sys.includes('Stage 1 Option B Semantic Alignment Judge')) {
      const score = this.options.customAlignmentScore ?? 85;
      const data = {
        score,
        categoryConflict: score < 70,
        reasoning:
          score >= 70
            ? 'Strong alignment with channel DNA and systemic paradoxes.'
            : 'Topic is too generic for this channel DNA; reframe using one of the 3 angles.',
        reframingAngles: [
          'The Hidden Mechanism Behind Everyday Fatigue',
          'Why Cellular Clocks Sabotage Modern Sleep Cycles',
          'Forensic Anatomy of the 3 AM Cortisol Spike',
        ],
        hook15s: 'Within 15 seconds your optic nerve resets every organ clock.',
        somaticHook15s: 'Within 15 seconds your optic nerve resets every organ clock.',
        coreParadox: 'Artificial light tricks ancient circadian neurons into perpetual noon.',
        thumbnailIdea: 'CLOCK BROKEN',
      };
      return {
        data: data as unknown as T,
        rawText: JSON.stringify(data),
        modelUsed: 'models/gemini-flash-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 2B: Structured Extraction from Step 2A Grounded Brief
    if (sys.includes('Stage 2B Multi-Modal Knowledge Graph')) {
      const data = {
        shockPoint: {
          fact: 'Core prefrontal glucose utilization drops by 24% during circadian nadir.',
          source: 'Stanford Chronobiology Metabolic Study (2024)',
          link: 'https://stanford.edu/chronobiology-2024',
        },
        evidence: [
          {
            id: 'ev-1',
            claim: 'Prefrontal glucose utilization drops 24% during the 3 AM circadian trough.',
            leadSource: 'Stanford Chronobiology Metabolic Study',
            institution: 'Stanford University',
            year: '2024',
            methodology: 'PET-fMRI Longitudinal Cohort (n=412)',
            link: 'https://stanford.edu/chronobiology-2024',
          },
          {
            id: 'ev-2',
            claim: 'Suprachiasmatic nucleus neurons desynchronize under blue-spectrum exposure.',
            leadSource: 'Harvard SCN Phase Locking Analysis',
            institution: 'Harvard Medical School',
            year: '2023',
            methodology: 'Electrophysiological Patch-Clamp Assay',
            link: 'https://hms.harvard.edu/scn-phase-2023',
          },
          {
            id: 'ev-ungrounded',
            claim: 'Unverified claim from a link not present in Step 2A grounding.',
            leadSource: 'Fabricated Blog',
            institution: 'Unknown Institute',
            year: '2022',
            methodology: 'Anecdotal',
            link: 'https://unverified-hallucinated-domain.example.com/fake-study',
          },
        ],
        triples: [
          {
            subject: 'Suprachiasmatic Nucleus',
            predicate: 'regulates',
            object: 'Prefrontal Glucose Metabolism',
            evidenceId: 'ev-1',
          },
          {
            subject: 'Blue-Spectrum Light',
            predicate: 'desynchronizes',
            object: 'Circadian Pacemaker Neurons',
            evidenceId: 'ev-2',
          },
        ],
        clusters: [
          {
            name: 'Metabolic Nadir Mechanics',
            facts: ['24% glucose drop at 03:17 AM', 'Vagal tone shift'],
          },
        ],
        mdvi: {
          score: 91,
          breakdown: {
            scientificDepth: 94,
            narrativeFriction: 90,
            visualDensity: 89,
          },
        },
        primaryAnchor: 'Suprachiasmatic Pacemaker Precision',
        counterAnchor: 'Modern Artificial Light Desynchronization',
      };
      return {
        data: data as unknown as T,
        rawText: JSON.stringify(data),
        modelUsed: 'models/gemini-pro-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 2.5: Runtime & Harmon Chapters
    if (
      req.stage === 'S2.5' ||
      sys.includes('Stage 2.5 Runtime, Word Budget')
    ) {
      const chapters = Array.from({ length: 7 }, (_, idx) => ({
        phaseIndex: idx + 1,
        chapterTitle: `Chapter ${idx + 1}: The Circadian Threshold`,
        narrativeBeat: `Execute phase ${idx + 1} progression with empirical tension.`,
        anchorIds: ['ev-1', 'ev-2'],
      }));
      const metaphorCandidates = Array.from({ length: 5 }, (_, idx) => ({
        id: `meta-${idx + 1}`,
        metaphor: `A master atomic pendulum inside a dark vault (#${idx + 1})`,
        visceralScore: 9.5,
        clarityScore: 9.5,
        noveltyScore: 9.0,
        retentionScore: 9.5,
        rationale: 'Makes microscopic cellular timing immediately visual and tactile.',
      }));
      const cognitiveAnchors = Array.from({ length: 7 }, (_, idx) => ({
        phaseName: `Phase ${idx + 1}`,
        primaryClaimId: 'ev-1',
        counterpointClaimId: 'ev-2',
        emotionalFrictionCue: 'Sudden drop in core temperature and pulse cadence.',
      }));
      const data = { chapters, metaphorCandidates, cognitiveAnchors };
      return {
        data: data as unknown as T,
        rawText: JSON.stringify(data),
        modelUsed: 'models/gemini-pro-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 3: Dual Script Generation
    if (req.stage === 'S3' || sys.includes('Stage 3 Dual-Output Script Engine')) {
      const isLatinScript =
        /Script:\s*Latin/i.test(sys) ||
        /Latin phonetic orthography/i.test(sys) ||
        /pure Latin script/i.test(sys) ||
        /Language: en \(Latin\)/i.test(sys);
      const brandMatch =
        req.userPrompt.match(/Brand Name:\s*([^\n.]+)/i) ||
        sys.match(/Include the brand name "([^"]+)"/i) ||
        sys.match(/Brand Name \(include ONLY in the final payoff paragraph\):\s*([^\n.]+)/i);
      const detectedBrand = brandMatch
        ? brandMatch[1].trim()
        : this.options.brandName ?? 'FactLock';

      const paragraphs = isLatinScript
        ? buildCompliantEnglishParagraphs({
            targetMinutes: this.options.targetMinutes ?? 11,
            wpm: this.options.wpm ?? 160,
            brandName: detectedBrand,
          })
        : buildCompliantHindiParagraphs({
            targetMinutes: this.options.targetMinutes ?? 11,
            wpm: this.options.wpm ?? 187.41,
            brandName: detectedBrand,
          });
      const glossary = [
        {
          term: 'Suprachiasmatic Nucleus',
          meaning: isLatinScript
            ? 'Master circadian pacemaker in the hypothalamus'
            : 'मस्तिष्क की मुख्य जैविक घड़ी',
          usage: isLatinScript
            ? 'Controls 24-hour biological cycles'
            : 'हाइपोथैलेमस में स्थित नियंत्रण केंद्र',
        },
      ];
      return {
        data: { paragraphs, glossary } as unknown as T,
        rawText: JSON.stringify({ paragraphs, glossary }),
        modelUsed: 'models/gemini-pro-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 3: 17-Point Audit Semantic Judge (C13..C17)
    if (sys.includes('17-Point Audit Semantic Judge')) {
      if (this.options.judgeThrows) {
        throw new Error('Simulated LLM Judge network timeout');
      }
      const data = {
        fleschKincaidAsrScore: 90,
        hook15sScore: 92,
        emotionalEngagementScore: 89,
        visualGroundingScore: 91,
        noHallucinatedCitations: true,
        critique: 'All semantic checks verified against grounded evidence.',
        failingParagraphIndices: [],
      };
      return {
        data: data as unknown as T,
        rawText: JSON.stringify(data),
        modelUsed: 'models/gemini-flash-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 3: Tri-Node Surgical Repair
    if (sys.includes('Tri-Node Surgical Script Repair Engine')) {
      if (this.options.repairAlwaysFails) {
        const bad = ', छोटा वाक्य।';
        return {
          data: {
            repairedParagraph: bad,
            repairedSpokenParagraph: bad,
          } as unknown as T,
          rawText: JSON.stringify({ repairedParagraph: bad }),
          modelUsed: 'models/gemini-pro-latest',
          keyIdUsed: 1,
        };
      }

      const isLatinScript = /pure Latin/i.test(sys);
      const cleanPara = isLatinScript
        ? ', Therefore understanding microscopic transistor leakage currents remains critical for every hardware architect designing modern computing systems. Nevertheless thermal dissipation pathways across copper heatspreaders operate continuously without pause during heavy rendering workloads. Consequently when engineers inspect silicon wafers under electron microscopes surprising structural anomalies appear near memory controllers? Because millions of synchronized clock gates regulate core voltage levels quietly across every single processing cluster. Furthermore subtle electromagnetic interference inside dense circuit boards gradually degrades signal integrity over extended operating cycles. Therefore modern semiconductor fabrication laboratories treat nanoscale lithography alignment as their most demanding engineering puzzle today?'
        : ', इसलिए तंत्रिका तंत्र के भीतर छिपे सूक्ष्म संकेतों को समझना हर शोधकर्ता के लिए बेहद ज़रूरी होता है। इसके बावजूद कोशिकाओं का यह जटिल चक्र बिना रुके चौबीस घंटे पूरी सटीकता के साथ काम करता है। परिणामस्वरूप जब हम मस्तिष्क की गहराई में झाँकते हैं तो चौंकाने वाले जैविक तथ्य स्पष्ट दिखाई देते हैं? क्योंकि हर सेकंड लाखों विद्युत तरंगें हमारे शरीर के तापमान और रक्तचाप को चुपचाप नियंत्रित करती रहती हैं। उदाहरण के लिए गहरे समुद्र के दबाव की तरह यह मानसिक तनाव धीरे धीरे भीतर बढ़ता जाता है। यही कारण है कि आधुनिक चिकित्सा विज्ञान इस अनोखी शारीरिक प्रक्रिया को एक बड़ी पहेली मानता आया है? इसलिए तंत्रिका तंत्र के भीतर छिपे सूक्ष्म संकेतों को समझना हर शोधकर्ता के लिए बेहद ज़रूरी होता है। इसके बावजूद कोशिकाओं का यह जटिल चक्र बिना रुके चौबीस घंटे पूरी सटीकता के साथ काम करता है।';
      return {
        data: {
          repairedParagraph: cleanPara,
          repairedSpokenParagraph: cleanPara,
        } as unknown as T,
        rawText: JSON.stringify({ repairedParagraph: cleanPara }),
        modelUsed: 'models/gemini-pro-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 6: Visual Prompt Translation
    if (sys.includes('Stage 6 Cross-Lingual Visual Prompt Translation')) {
      this.s6CallCount += 1;
      if (
        typeof this.options.s6IncompleteTimes === 'number' &&
        this.s6CallCount <= this.options.s6IncompleteTimes
      ) {
        return {
          data: { visualSpecs: [] } as unknown as T,
          rawText: JSON.stringify({ visualSpecs: [] }),
          modelUsed: 'models/gemini-flash-latest',
          keyIdUsed: 1,
        };
      }

      const slotMatches = Array.from(
        req.userPrompt.matchAll(/(?:"slotIndex":\s*(\d+)|Slot #(\d+))/g)
      ).map((m) => Number(m[1] || m[2]));
      const indices =
        slotMatches.length > 0
          ? slotMatches
          : Array.from({ length: 30 }, (_, idx) => idx + 1);

      const emotions = ['TENSION', 'DREAD', 'URGENCY', 'REVELATION', 'ISOLATION', 'AWE'];
      const frameTypes: Array<'PROTAGONIST' | 'OBJECT' | 'SCENIC'> = ['PROTAGONIST', 'OBJECT', 'SCENIC'];
      const visualSpecs = indices.map((slotIndex, idx) => ({
        slotIndex,
        subjectDescription: `Forensic macro view of neural clock circuit #${slotIndex}`,
        environmentDescription: 'Obsidian laboratory with volumetric cyan bioluminescence',
        actionTrajectory: 'smooth dolly push toward the oscillating core',
        emotionTag: emotions[idx % emotions.length],
        lightingSpec: 'High-contrast chiaroscuro rim lighting',
        frameType: frameTypes[idx % frameTypes.length],
      }));
      return {
        data: { visualSpecs } as unknown as T,
        rawText: JSON.stringify({ visualSpecs }),
        modelUsed: 'models/gemini-flash-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 7 Express: Derive Topic & SPO Triples
    if (
      req.stage === 'S7_EXPRESS_DERIVE_TOPIC' ||
      sys.includes('Express Script Analyzer')
    ) {
      const data = {
        topicTitle: 'Express Voiceover Architecture Analysis',
        shockPoint: 'Inside modern architectures, anomalous current leaks silently corrupt memory states',
        triples: [
          { subject: 'Transistor Leakage', predicate: 'causes', object: 'Memory Gate Instability' },
          { subject: 'Clock Jitter', predicate: 'degrades', object: 'Signal Synchronization' },
          { subject: 'Thermal Throttling', predicate: 'limits', object: 'Peak Silicon Throughput' },
        ],
      };
      return {
        data: data as unknown as T,
        rawText: JSON.stringify(data),
        modelUsed: 'models/gemini-flash-latest',
        keyIdUsed: 1,
      };
    }

    // Stage 7: Packaging 3 Variants & 4-Tier Tags
    if (sys.includes('Stage 7 Packaging, Thumbnail FACS & SEO Engine')) {
      this.s7CallCount += 1;
      if (
        typeof this.options.s7IncompleteTimes === 'number' &&
        this.s7CallCount <= this.options.s7IncompleteTimes
      ) {
        // Return only 2 variants to trigger retry / PACKAGING_INCOMPLETE
        const partialData = {
          variants: [
            {
              id: 'PACK_A',
              title: 'Why Your Brain Freezes at 3:17 AM',
              overlayText: 'FATAL PULSE',
              thumbnailPrompt:
                'Extreme close-up of a researcher with widened eyelids, tense brow, and parted lips in cold cyan laboratory light.',
            },
            {
              id: 'PACK_B',
              title: 'The Hidden War Inside Your Cellular Clock',
              overlayText: 'SYSTEM CLASH',
              thumbnailPrompt:
                'Split-diopter composition showing a glowing neural circuit clashing against a fractured mechanical chronometer.',
            },
          ],
          tags: {
            broad: ['Science'],
            subNiche: ['Chronobiology', 'Neuroscience'],
            entity: ['Suprachiasmatic Nucleus', 'Stanford Sleep Lab', 'Circadian Rhythm', 'Cortisol'],
            longTail: [
              'why brain wakes up at 3am explained',
              'circadian rhythm analysis',
              'suprachiasmatic nucleus metabolism study',
            ],
          },
          pinnedComment: 'Read the studies linked in the description.',
        };
        return {
          data: partialData as unknown as T,
          rawText: JSON.stringify(partialData),
          modelUsed: 'models/gemini-pro-latest',
          keyIdUsed: 1,
        };
      }

      const data = {
        variants: [
          {
            id: 'PACK_A',
            title: 'Why Your Brain Freezes at 3:17 AM',
            overlayText: 'FATAL PULSE',
            thumbnailPrompt:
              'Extreme close-up of a researcher with widened eyelids, tense brow, and parted lips in cold cyan laboratory light. Leave the bottom-right 20% of the frame unobstructed as a clean timestamp safe zone.',
          },
          {
            id: 'PACK_B',
            title: 'The Hidden War Inside Your Cellular Clock',
            overlayText: 'SYSTEM CLASH',
            thumbnailPrompt:
              'Split-diopter composition showing a glowing neural circuit clashing against a fractured mechanical chronometer with furrowed brow tension. Leave the bottom-right 20% of the frame unobstructed as a clean timestamp safe zone.',
          },
          {
            id: 'PACK_C',
            title: 'Trapped Inside the Circadian Abyss',
            overlayText: 'LONE WITNESS',
            thumbnailPrompt:
              'Scale Paradox composition: human subject occupies 35% of frame height dwarfed by a towering bioluminescent neural monolith, with widened eyes and parted lips. Leave the bottom-right 20% of the frame unobstructed as a clean timestamp safe zone.',
          },
        ],
        tags: {
          broad: ['Science'],
          subNiche: ['Chronobiology', 'Neuroscience'],
          entity: ['Suprachiasmatic Nucleus', 'Stanford Sleep Lab', 'Circadian Rhythm', 'Cortisol'],
          longTail: [
            'why brain wakes up at 3am explained',
            'circadian rhythm deep dive',
            'suprachiasmatic nucleus metabolism study',
          ],
        },
        pinnedComment:
          'Have you ever woken up at 3:17 AM? Read the Stanford & Harvard studies linked in the description.',
      };
      return {
        data: data as unknown as T,
        rawText: JSON.stringify(data),
        modelUsed: 'models/gemini-pro-latest',
        keyIdUsed: 1,
      };
    }

    return {
      data: {} as T,
      rawText: '{}',
      modelUsed: 'models/gemini-flash-latest',
      keyIdUsed: 1,
    };
  }

  async embedTexts(params: {
    db: unknown;
    projectId?: string | null;
    texts: string[];
  }): Promise<{ vectors: number[][]; modelUsed: string; keyIdUsed: number }> {
    this.embedCalls.push(params.texts);
    if (this.options.emriFail) {
      const vectors = params.texts.map((_, idx) =>
        idx === params.texts.length - 1 ? [1, 0, 0] : [-1, 0, 0]
      );
      return {
        vectors,
        modelUsed: 'models/gemini-embedding-exp',
        keyIdUsed: 1,
      };
    }
    const vectors = params.texts.map((_, idx) =>
      idx === params.texts.length - 1 ? [1, 0, 0] : [0.96, 0.28, 0]
    );
    return {
      vectors,
      modelUsed: 'models/gemini-embedding-exp',
      keyIdUsed: 1,
    };
  }
}
