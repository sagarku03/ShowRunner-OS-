import type { GenerationMode } from '../../src/config/constants.ts';

export type Provenance = 'EXPLICIT' | 'INFERRED' | 'DEFAULT';

export interface ProvenanceField<T> {
  value: T;
  provenance: Provenance;
}

export interface MasterPromptChapter {
  name: string;
  startTime?: string;
  endTime?: string;
  approxWords?: number;
  sharePct: number;
  provenance: Provenance;
}

export interface MasterPromptBlacklistEntry {
  videoNumber?: number;
  title: string;
  coreAnchors: string[];
  bannedDomain?: string;
}

export interface MasterPromptReplacement {
  from: string;
  to: string;
}

export interface MasterPromptProfile {
  identity: {
    channelName: ProvenanceField<string | null>;
    spokenChannelName: ProvenanceField<string | null>;
    channelUrl: ProvenanceField<string>;
    persona: ProvenanceField<string>;
    niche: ProvenanceField<string>;
    editorialStrategy: ProvenanceField<string>;
    audience: ProvenanceField<string>;
  };
  language: {
    uiLanguage: ProvenanceField<'Hinglish' | 'Hindi' | 'English'>;
    voiceoverLanguage: ProvenanceField<string>;
    script: ProvenanceField<'Devanagari' | 'Latin'>;
    ttsEngine: ProvenanceField<string>;
    leadingCommaRule: ProvenanceField<boolean>;
    numbersAsWordsRule: ProvenanceField<boolean>;
    zeroLatinRule: ProvenanceField<boolean>;
    addressForm: ProvenanceField<string>;
  };
  budget: {
    wordBudgetMin: ProvenanceField<number>;
    wordBudgetMax: ProvenanceField<number>;
    targetWords: ProvenanceField<number>;
    paragraphMin: ProvenanceField<number>;
    paragraphMax: ProvenanceField<number>;
    wordsPerParagraph: ProvenanceField<number>;
    sentenceWordsMin: ProvenanceField<number>;
    sentenceWordsMax: ProvenanceField<number>;
    wpm: ProvenanceField<number>;
    hookSeconds: ProvenanceField<number>;
    outroWords: ProvenanceField<number>;
    ctaKeyword: ProvenanceField<string>;
    subLoopSeconds: ProvenanceField<number>;
  };
  chapters: MasterPromptChapter[];
  visual: {
    visualStyleLine: ProvenanceField<string>;
    stylePrefix: ProvenanceField<string>;
    characterAnchor: ProvenanceField<string>;
    noFigureMarkers: string[];
    negativePrompts: string[];
    imageEngine: ProvenanceField<string>;
    noCliFlags: ProvenanceField<boolean>;
    shotPattern: ProvenanceField<string>;
  };
  pacing: {
    cutMinSec: ProvenanceField<number>;
    cutMaxSec: ProvenanceField<number>;
    timestampFormat: ProvenanceField<string>;
    hyphenOnly: ProvenanceField<boolean>;
    startTimeOnly: ProvenanceField<boolean>;
    recommendedMode: ProvenanceField<GenerationMode | null>;
  };
  rules: {
    bannedWords: string[];
    replacements: MasterPromptReplacement[];
  };
  blacklist: MasterPromptBlacklistEntry[];
  moratoria: string[];
  warnings: string[];
}

function field<T>(value: T, provenance: Provenance): ProvenanceField<T> {
  return { value, provenance };
}

function parseTimeToMinutes(timeStr?: string): number | null {
  if (!timeStr) return null;
  const parts = timeStr.trim().split(':');
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    return Number.isFinite(m) && Number.isFinite(s) ? m + s / 60 : null;
  }
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    return Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s) ? h * 60 + m + s / 60 : null;
  }
  return null;
}

/**
 * Pure deterministic parser for creator Master Prompts (A1).
 * Works completely offline with zero DB and network calls. Never throws and never invents values.
 */
export function extractMasterPromptProfile(rawText: string): MasterPromptProfile {
  const text = String(rawText ?? '');
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];

  if (!text.trim()) {
    warnings.push('Master prompt text is empty.');
  }

  // 1. Identity
  let channelName = field<string | null>(null, 'DEFAULT');
  const chMatch = text.match(/(?:CHANNEL\s*NAME|channel|brand\s*name|brand):\s*["“']?([^"”'\r\n]+)["“']?/i);
  if (chMatch && chMatch[1].trim()) {
    const cleanName = chMatch[1].replace(/\s*\([^)]*\).*$/, '').replace(/["“'”]/g, '').trim();
    if (cleanName) {
      channelName = field(cleanName, 'EXPLICIT');
    }
  }

  let spokenChannelName = field<string | null>(null, 'DEFAULT');
  const spokenMatch = text.match(
    /(?:CHANNEL\s*NAME\s*\(SPOKEN[^)]*\)|spoken\s*channel\s*name|spoken\s*name):\s*["“']?([^"”'\r\n]+)["“']?/i
  );
  if (spokenMatch && spokenMatch[1].trim()) {
    spokenChannelName = field(spokenMatch[1].replace(/["“'”]/g, '').trim(), 'EXPLICIT');
  } else {
    const loanwordMatch = text.match(/loanwords,\s*and\s*['"“]([^'"”]+)['"”]/i);
    if (loanwordMatch && loanwordMatch[1].trim()) {
      spokenChannelName = field(loanwordMatch[1].trim(), 'EXPLICIT');
    } else if (channelName.provenance === 'EXPLICIT' && channelName.value) {
      spokenChannelName = field(channelName.value, 'INFERRED');
    }
  }

  let channelUrl = field('', 'DEFAULT');
  const urlMatch = text.match(/https?:\/\/(?:www\.)?youtube\.com\/[^\s)"',]+/i);
  if (urlMatch) {
    channelUrl = field(urlMatch[0].trim(), 'EXPLICIT');
  }

  let persona = field('Sharp investigative storyteller with high empirical clarity', 'DEFAULT');
  const personaMatch =
    text.match(/You\s+are\s+["“]([^"”]+)["”]/i) ||
    text.match(/You\s+are\s+([A-Z0-9_-]+)/) ||
    text.match(/(?:persona|creator\s*persona):\s*["“']?([^"”'\r\n]+)["“']?/i);
  if (personaMatch && personaMatch[1].trim()) {
    persona = field(personaMatch[1].trim(), 'EXPLICIT');
  } else if (!text.trim()) {
    persona = field('', 'DEFAULT');
  }

  let niche = field('General Creator Channel', 'DEFAULT');
  const nicheMatch = text.match(/(?:Niche|Niche\s*&\s*Sub-Niche):\s*["“']?([^"”'\r\n]+)["“']?/i);
  if (nicheMatch && nicheMatch[1].trim()) {
    niche = field(nicheMatch[1].trim(), 'EXPLICIT');
  }

  let editorialStrategy = field('', 'DEFAULT');
  const stratMatch = text.match(/(?:Editorial\s*Strategy|strategy):\s*["“']?([^"”'\r\n]+)["“']?/i);
  if (stratMatch && stratMatch[1].trim()) {
    editorialStrategy = field(stratMatch[1].trim(), 'EXPLICIT');
  }

  let audience = field('', 'DEFAULT');
  const audMatch = text.match(/(?:Target\s*Audience|audience):\s*["“']?([^"”'\r\n]+)["“']?/i);
  if (audMatch && audMatch[1].trim()) {
    audience = field(audMatch[1].trim(), 'EXPLICIT');
  }

  // 2. Language & Script
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  const mentionsHinglish = /\bhinglish\b/i.test(text);
  const mentionsHindi = /\bhindi\b/i.test(text);

  let uiLanguage = field<'Hinglish' | 'Hindi' | 'English'>('English', 'DEFAULT');
  let voiceoverLanguage = field('English', 'DEFAULT');
  let script = field<'Devanagari' | 'Latin'>('Latin', 'DEFAULT');

  const langMatch = text.match(/(?:Language|Primary\s*UI[^:]*Language):\s*["“']?([^"”'\r\n]+)["“']?/i);
  if (langMatch) {
    const val = langMatch[1].trim();
    if (/hinglish/i.test(val)) {
      uiLanguage = field('Hinglish', 'EXPLICIT');
      voiceoverLanguage = field('Hinglish', 'EXPLICIT');
      script = field('Devanagari', 'EXPLICIT');
    } else if (/hindi/i.test(val)) {
      uiLanguage = field('Hindi', 'EXPLICIT');
      voiceoverLanguage = field('Hindi', 'EXPLICIT');
      script = field('Devanagari', 'EXPLICIT');
    } else if (/english/i.test(val)) {
      uiLanguage = field('English', 'EXPLICIT');
      voiceoverLanguage = field('English', 'EXPLICIT');
      script = field('Latin', 'EXPLICIT');
    }
  } else if (mentionsHinglish) {
    uiLanguage = field('Hinglish', 'EXPLICIT');
    voiceoverLanguage = field('Hinglish', 'EXPLICIT');
    script = field('Devanagari', 'EXPLICIT');
  } else if (mentionsHindi || hasDevanagari) {
    uiLanguage = field('Hindi', 'EXPLICIT');
    voiceoverLanguage = field('Hindi', 'EXPLICIT');
    script = field('Devanagari', 'EXPLICIT');
  }

  const scriptMatch = text.match(/(?:script):\s*["“']?([^"”'\r\n]+)["“']?/i);
  if (scriptMatch) {
    if (/devanagari/i.test(scriptMatch[1])) {
      script = field('Devanagari', 'EXPLICIT');
    } else if (/latin/i.test(scriptMatch[1])) {
      script = field('Latin', 'EXPLICIT');
    }
  }

  let ttsEngine = field('ElevenLabs', 'DEFAULT');
  const ttsMatch = text.match(/\b(ElevenLabs|Cartesia|OpenAI\s*TTS|Google\s*TTS)\b/i);
  if (ttsMatch) {
    ttsEngine = field(ttsMatch[1].trim(), 'EXPLICIT');
  }

  const leadingCommaRule = field(
    /leading\s*comma|starts?\s*with\s*,\s*|comma\s*\(\s*,\s*\)/i.test(text),
    /leading\s*comma|starts?\s*with\s*,\s*|comma\s*\(\s*,\s*\)/i.test(text) ? 'EXPLICIT' : 'DEFAULT'
  );

  const numbersAsWordsRule = field(
    /Devanagari\s*words\s*for\s*all\s*numbers|numbers\s*as\s*words|never\s*use\s*arabic\s*digits/i.test(text),
    /Devanagari\s*words\s*for\s*all\s*numbers|numbers\s*as\s*words|never\s*use\s*arabic\s*digits/i.test(text)
      ? 'EXPLICIT'
      : 'DEFAULT'
  );

  const zeroLatinRule = field(
    /zero\s*latin|no\s*latin\s*script|pure\s*devanagari/i.test(text),
    /zero\s*latin|no\s*latin\s*script|pure\s*devanagari/i.test(text) ? 'EXPLICIT' : 'DEFAULT'
  );

  let addressForm = field(script.value === 'Devanagari' ? 'आप' : 'you', 'DEFAULT');
  if (/\bआप\b/.test(text)) {
    addressForm = field('आप', 'EXPLICIT');
  } else if (/\bतुम\b/.test(text)) {
    addressForm = field('तुम', 'EXPLICIT');
  }

  // 3. Word Budget & Pacing
  let wordBudgetMin = field(1800, 'DEFAULT');
  let wordBudgetMax = field(2200, 'DEFAULT');
  let targetWords = field(2000, 'DEFAULT');

  const budgetRangeMatch = text.match(/([\d,]+)\s*[–—-]\s*([\d,]+)\s*(?:-word|\s*words)/i);
  if (budgetRangeMatch) {
    const minW = Number(budgetRangeMatch[1].replace(/,/g, ''));
    const maxW = Number(budgetRangeMatch[2].replace(/,/g, ''));
    if (Number.isFinite(minW) && Number.isFinite(maxW) && minW > 0 && maxW >= minW) {
      wordBudgetMin = field(minW, 'EXPLICIT');
      wordBudgetMax = field(maxW, 'EXPLICIT');
      targetWords = field(Math.round((minW + maxW) / 2), 'EXPLICIT');
    }
  } else {
    const singleBudgetMatch = text.match(/([\d,]+)\s*(?:-word|\s*words)\s*(?:budget|target|total)/i);
    if (singleBudgetMatch) {
      const w = Number(singleBudgetMatch[1].replace(/,/g, ''));
      if (Number.isFinite(w) && w > 0) {
        wordBudgetMin = field(Math.round(w * 0.95), 'INFERRED');
        wordBudgetMax = field(Math.round(w * 1.05), 'INFERRED');
        targetWords = field(w, 'EXPLICIT');
      }
    }
  }

  let paragraphMin = field(12, 'DEFAULT');
  let paragraphMax = field(16, 'DEFAULT');
  const paraRangeMatch = text.match(/(\d+)\s*[–—-]\s*(\d+)\s*(?:-paragraph|\s*paragraphs?)/i);
  if (paraRangeMatch) {
    paragraphMin = field(Number(paraRangeMatch[1]), 'EXPLICIT');
    paragraphMax = field(Number(paraRangeMatch[2]), 'EXPLICIT');
  }

  const avgParas = (paragraphMin.value + paragraphMax.value) / 2;
  const wordsPerParagraph = field(
    Math.round(targetWords.value / Math.max(1, avgParas)),
    paraRangeMatch ? 'INFERRED' : 'DEFAULT'
  );

  let sentenceWordsMin = field(14, 'DEFAULT');
  let sentenceWordsMax = field(22, 'DEFAULT');
  const sentenceRangeMatch = text.match(/(\d+)\s*[–—-]\s*(\d+)\s*words?\s*(?:per\s*sentence|sentence\s*length)/i);
  if (sentenceRangeMatch) {
    sentenceWordsMin = field(Number(sentenceRangeMatch[1]), 'EXPLICIT');
    sentenceWordsMax = field(Number(sentenceRangeMatch[2]), 'EXPLICIT');
  }

  let wpm = field(script.value === 'Devanagari' ? 187.41 : 160.0, 'DEFAULT');
  const wpmMatch = text.match(/(\d+(?:\.\d+)?)\s*WPM/i);
  if (wpmMatch) {
    const parsedWpm = Number(wpmMatch[1]);
    if (Number.isFinite(parsedWpm) && parsedWpm > 0) {
      wpm = field(parsedWpm, 'EXPLICIT');
    }
  }

  let hookSeconds = field(15, 'DEFAULT');
  const hookMatch =
    text.match(/hook(?:ing)?\s*(?:window|seconds|time)?[:\s]+(\d+)\s*s/i) ||
    text.match(/(\d+)\s*s(?:econds?)?\s*(?:opening\s*)?hook/i) ||
    text.match(/0\s*-\s*(\d+)\s*s/i);
  if (hookMatch) {
    hookSeconds = field(Number(hookMatch[1]), 'EXPLICIT');
  }

  let outroWords = field(40, 'DEFAULT');
  const outroMatch = text.match(/outro\s*(?:words?|budget)?[:\s]+~?(\d+)/i);
  if (outroMatch) {
    outroWords = field(Number(outroMatch[1]), 'EXPLICIT');
  }

  let ctaKeyword = field('', 'DEFAULT');
  const ctaMatch =
    text.match(/(?:spoken\s*keyword\s*lock|CTA\s*keyword)[:\s]+["“']?([^"”'\r\n]+)["“']?/i) ||
    text.match(/lock\s*["“']([^"”'\r\n]+)["“']\s*as\s*(?:CTA|outro)/i);
  if (ctaMatch && ctaMatch[1].trim()) {
    ctaKeyword = field(ctaMatch[1].trim(), 'EXPLICIT');
  }

  let subLoopSeconds = field(45, 'DEFAULT');
  const subLoopMatch = text.match(/sub-loop\s*(?:cadence|seconds)?[:\s]+(\d+)/i);
  if (subLoopMatch) {
    subLoopSeconds = field(Number(subLoopMatch[1]), 'EXPLICIT');
  }

  // 4. Chapters
  const chapters: MasterPromptChapter[] = [];
  const chapterLines = lines.filter((l) =>
    /^(?:Ch(?:apter)?\s*\d+|###\s*CHAPTER\s*\d+)/i.test(l.trim())
  );

  for (const line of chapterLines) {
    const m = line.match(
      /^(?:###\s*)?Ch(?:apter)?\s*(\d+)[:.]\s*([^[\r\n~]+?)(?:\[\s*(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})\s*\])?(?:\s*~?\s*([\d,]+)\s*words?)?$/i
    );
    if (m) {
      const name = m[2].trim();
      const startTime = m[3]?.trim();
      const endTime = m[4]?.trim();
      const approxWords = m[5] ? Number(m[5].replace(/,/g, '')) : undefined;
      chapters.push({
        name,
        startTime,
        endTime,
        approxWords,
        sharePct: 0,
        provenance: 'EXPLICIT',
      });
    }
  }

  // Also support inline comma-separated chapter list: "Chapters: Ch1 Trap, Ch2 Math, Ch3 Bias..."
  if (chapters.length === 0) {
    const inlineMatch = text.match(/Chapters:\s*([^\r\n]+)/i);
    if (inlineMatch) {
      const parts = inlineMatch[1].split(/[,;]/);
      for (const p of parts) {
        const item = p.trim();
        if (!item) continue;
        chapters.push({
          name: item,
          sharePct: 0,
          provenance: 'EXPLICIT',
        });
      }
    }
  }

  // Calculate chapter shares
  const totalApproxWords = chapters.reduce((sum, c) => sum + (c.approxWords || 0), 0);
  if (chapters.length > 0) {
    chapters.forEach((c) => {
      if (totalApproxWords > 0 && c.approxWords) {
        c.sharePct = Math.round((c.approxWords / totalApproxWords) * 100);
      } else {
        c.sharePct = Math.round(100 / chapters.length);
      }
    });
  }

  // Check chapter timeline vs word budget runtime mismatch warning
  if (chapters.length > 0) {
    const lastChapter = chapters[chapters.length - 1];
    const endMinutes = parseTimeToMinutes(lastChapter.endTime);
    if (endMinutes !== null && endMinutes > 0) {
      const estBudgetMinutes = targetWords.value / wpm.value;
      if (Math.abs(endMinutes - estBudgetMinutes) > 3.0) {
        warnings.push(
          `Chapter timeline runtime (${endMinutes.toFixed(1)}m) does not align with word budget duration (${estBudgetMinutes.toFixed(1)}m).`
        );
      }
    }
  }

  // 5. Visuals
  let visualStyleLine = field('', 'DEFAULT');
  const styleLineMatch = text.match(/(?:Visual\s*Style|Art\s*Style):\s*["“']?([^"”'\r\n]+)["“']?/i);
  if (styleLineMatch && styleLineMatch[1].trim()) {
    visualStyleLine = field(styleLineMatch[1].trim(), 'EXPLICIT');
  }

  let stylePrefix = field('', 'DEFAULT');
  const prefixMatch = text.match(
    /["“']#\[MM-SS\.mmm\]\s*([^"”'\r\n]+)["“']/i
  );
  if (prefixMatch && prefixMatch[1].trim()) {
    stylePrefix = field(prefixMatch[1].trim(), 'EXPLICIT');
  }

  let characterAnchor = field('', 'DEFAULT');
  const anchorMatch = text.match(/["“']?([^"”'\r\n[\]]+?)\s*\[EXACT\s*CHARACTER\s*ACTION\/POSE\]/i);
  if (anchorMatch && anchorMatch[1].trim()) {
    const cleanAnchor = anchorMatch[1]
      .replace(/^[^a-zA-Z0-9\u0900-\u097F]+/, '')
      .replace(/\.\.\./g, '')
      .trim();
    if (cleanAnchor) {
      characterAnchor = field(cleanAnchor, 'EXPLICIT');
    }
  }

  const noFigureMarkers: string[] = [];
  const noFigMatches = text.matchAll(/\((?:no\s+(?:human|stickman|figure|person)[^)]*)\)/gi);
  for (const m of noFigMatches) {
    const val = m[0].trim();
    if (!noFigureMarkers.includes(val)) {
      noFigureMarkers.push(val);
    }
  }

  const negativePrompts: string[] = [];
  const negMatches = text.matchAll(/(?:ZERO\s*3D[^.\n]+|Strictly\s*ban[^.\n]+|Avoid[^.\n]+)/gi);
  for (const nm of negMatches) {
    const cleaned = nm[0].replace(/^Avoid\s+/i, '').replace(/^Strictly\s*ban\s+/i, '').trim();
    if (cleaned && !negativePrompts.includes(cleaned)) {
      negativePrompts.push(cleaned);
    }
  }

  let imageEngine = field('', 'DEFAULT');
  const engineMatch = text.match(/\b(Google\s*Flow\s*AI|Midjourney|Imagen|DALL-E|Stable\s*Diffusion)\b/i);
  if (engineMatch) {
    imageEngine = field(engineMatch[1].trim(), 'EXPLICIT');
  }

  const noCliFlags = field(
    /NEVER\s*output\s*(?:Midjourney\s*parameters|CLI\s*flags)|no\s*cli\s*flags|--no|--ar|--v/i.test(text),
    /NEVER\s*output\s*(?:Midjourney\s*parameters|CLI\s*flags)|no\s*cli\s*flags|--no|--ar|--v/i.test(text)
      ? 'EXPLICIT'
      : 'DEFAULT'
  );

  let shotPattern = field('', 'DEFAULT');
  const shotMatch = text.match(/Shot\s*[A-Z]\/[A-Z]\/[A-Z]/i);
  if (shotMatch) {
    shotPattern = field(shotMatch[0].trim(), 'EXPLICIT');
  }

  // 6. Pacing & Cut window
  let cutMinSec = field(1.0, 'DEFAULT');
  let cutMaxSec = field(2.8, 'DEFAULT');
  const cutMatch =
    text.match(/(?:cuts|pacing)?[:\s]*(\d+(?:\.\d+)?)\s*(?:to|–|-)\s*(\d+(?:\.\d+)?)\s*s/i) ||
    text.match(/between\s*(\d+(?:\.\d+)?)\s*s?\s*and\s*(\d+(?:\.\d+)?)\s*s/i) ||
    text.match(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*s/i);
  if (cutMatch) {
    const cMin = Number(cutMatch[1]);
    const cMax = Number(cutMatch[2]);
    if (Number.isFinite(cMin) && Number.isFinite(cMax) && cMin > 0 && cMax >= cMin) {
      cutMinSec = field(cMin, 'EXPLICIT');
      cutMaxSec = field(cMax, 'EXPLICIT');
    }
  }

  const timestampFormat = field('#[MM-SS.mmm]', 'DEFAULT');
  const hyphenOnly = field(true, 'DEFAULT');
  const startTimeOnly = field(true, 'DEFAULT');

  // recommendedMode: image engine + cut max <= 3.0s -> MODE_1_IMAGE
  let recommendedMode = field<GenerationMode | null>(null, 'DEFAULT');
  const isImageEngine =
    imageEngine.provenance === 'EXPLICIT' ||
    /\bimage\s*(?:prompt|batch|engine|generation)\b/i.test(text) ||
    stylePrefix.provenance === 'EXPLICIT';

  if (isImageEngine && cutMaxSec.value <= 3.0) {
    recommendedMode = field<GenerationMode | null>('MODE_1_IMAGE', 'INFERRED');
  }

  // 7. Banned Words & Replacements
  const bannedWords: string[] = [];
  const uiIgnoreWords = new Set(['starttime', 'endtime', 'copy', 'start', 'end']);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    if (/(?:banned|forbidden|strictly\s*ban|never\s*use|do\s*not\s*use)/i.test(trimmed)) {
      if (/only\s*when|permitted/i.test(trimmed)) continue;
      if (/StartTime|EndTime|Copy\s*button/i.test(trimmed)) continue;

      const stripped = trimmed.replace(/(?:e\.g\.|for\s*example).*$/i, '');
      const colonIdx = stripped.indexOf(':');
      if (colonIdx !== -1) {
        const afterColon = stripped.slice(colonIdx + 1).trim();
        if (afterColon) {
          const tokens = afterColon
            .split(/[,;•\n\t]/)
            .map((t) => t.replace(/["'“”()[\]{}]/g, '').trim())
            .filter(Boolean);
          for (const rawToken of tokens) {
            const cleanToken = rawToken.replace(/^[-*•\s]+/, '').trim();
            if (!cleanToken) continue;
            if (uiIgnoreWords.has(cleanToken.toLowerCase())) continue;
            if (script.value === 'Devanagari' && /^[a-zA-Z\s_-]+$/.test(cleanToken)) continue;
            if (!bannedWords.includes(cleanToken)) bannedWords.push(cleanToken);
          }
        }
      }

      // Check subsequent lines for bullet list items
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j].trim();
        if (!nextLine || nextLine.startsWith('#')) break;
        if (/^[a-zA-Z0-9_\s]+:/.test(nextLine) && !/^[-*•]/.test(nextLine)) break;
        if (/^[-*•]/.test(nextLine)) {
          const cleanItem = nextLine.replace(/^[-*•\s]+/, '').replace(/["'“”()[\]{}]/g, '').trim();
          if (cleanItem && !uiIgnoreWords.has(cleanItem.toLowerCase())) {
            if (!(script.value === 'Devanagari' && /^[a-zA-Z\s_-]+$/.test(cleanItem))) {
              if (!bannedWords.includes(cleanItem)) bannedWords.push(cleanItem);
            }
          }
          j++;
        } else {
          break;
        }
      }
    }
  }

  const replacements: MasterPromptReplacement[] = [];
  const repLines = lines.filter((l) => /\b(?:replace\s+.*with|->|→)\b/i.test(l));
  for (const line of repLines) {
    const arrowMatch = line.match(/["“']?([^"”'\s]+)["“']?\s*(?:->|→)\s*["“']?([^"”'\s]+)["“']?/);
    if (arrowMatch) {
      replacements.push({ from: arrowMatch[1].trim(), to: arrowMatch[2].trim() });
    }
  }

  // 8. Published-Video Blacklist
  const blacklist: MasterPromptBlacklistEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const vidMatch = line.match(/^Video\s*(\d+)[:.]\s*["“']?([^"”'\r\n]+)["“']?/i);
    if (vidMatch) {
      const videoNumber = Number(vidMatch[1]);
      const title = vidMatch[2].trim();
      let coreAnchors: string[] = [];
      let bannedDomain: string | undefined;

      // Check next 2 lines for Core Anchors and Banned Domain
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const nextLine = lines[j];
        const anchorMatch = nextLine.match(/Core\s*Anchors[:.]\s*([^\r\n]+)/i);
        if (anchorMatch) {
          coreAnchors = anchorMatch[1]
            .split(/[,;]/)
            .map((a) => a.trim())
            .filter(Boolean);
        }
        const domMatch = nextLine.match(/Banned\s*Domain[:.]\s*([^\r\n]+)/i);
        if (domMatch) {
          bannedDomain = domMatch[1].trim();
        }
      }

      blacklist.push({
        videoNumber,
        title,
        coreAnchors,
        bannedDomain,
      });
    }
  }

  const moratoria: string[] = [];
  const morMatch = text.match(/moratorium[:\s]+([^\r\n]+)/i);
  if (morMatch) {
    moratoria.push(morMatch[1].trim());
  }

  // Final warnings checks
  if (channelName.provenance === 'DEFAULT' && !text.trim()) {
    warnings.push('Channel name is not explicitly defined.');
  }
  if (niche.provenance === 'DEFAULT' && !text.trim()) {
    warnings.push('Niche is not explicitly defined.');
  }

  return {
    identity: {
      channelName,
      spokenChannelName,
      channelUrl,
      persona,
      niche,
      editorialStrategy,
      audience,
    },
    language: {
      uiLanguage,
      voiceoverLanguage,
      script,
      ttsEngine,
      leadingCommaRule,
      numbersAsWordsRule,
      zeroLatinRule,
      addressForm,
    },
    budget: {
      wordBudgetMin,
      wordBudgetMax,
      targetWords,
      paragraphMin,
      paragraphMax,
      wordsPerParagraph,
      sentenceWordsMin,
      sentenceWordsMax,
      wpm,
      hookSeconds,
      outroWords,
      ctaKeyword,
      subLoopSeconds,
    },
    chapters,
    visual: {
      visualStyleLine,
      stylePrefix,
      characterAnchor,
      noFigureMarkers,
      negativePrompts,
      imageEngine,
      noCliFlags,
      shotPattern,
    },
    pacing: {
      cutMinSec,
      cutMaxSec,
      timestampFormat,
      hyphenOnly,
      startTimeOnly,
      recommendedMode,
    },
    rules: {
      bannedWords,
      replacements,
    },
    blacklist,
    moratoria,
    warnings,
  };
}

/**
 * Calculates target spoken words from profile budget.
 */
export function profileTargetWords(profile: MasterPromptProfile): number {
  if (profile.budget.targetWords.value > 0) {
    return profile.budget.targetWords.value;
  }
  const minW = profile.budget.wordBudgetMin.value;
  const maxW = profile.budget.wordBudgetMax.value;
  if (minW > 0 && maxW >= minW) {
    return Math.round((minW + maxW) / 2);
  }
  return 2000;
}

/**
 * Calculates target minutes from profile words and WPM.
 */
export function profileTargetMinutes(profile: MasterPromptProfile): number {
  const words = profileTargetWords(profile);
  const w = profile.budget.wpm.value > 0 ? profile.budget.wpm.value : 187.41;
  return Number((words / w).toFixed(1));
}

/**
 * Merges LLM enrichment into a parsed MasterPromptProfile, only overriding DEFAULT or empty fields.
 */
export function mergeProfileEnrichment(
  profile: MasterPromptProfile,
  enrichment: Partial<MasterPromptProfile> | Record<string, unknown>
): MasterPromptProfile {
  const next: MasterPromptProfile = JSON.parse(JSON.stringify(profile));
  const en = enrichment as Record<string, any>;

  if (en.identity?.niche && next.identity.niche.provenance === 'DEFAULT') {
    next.identity.niche = field(String(en.identity.niche).trim(), 'INFERRED');
  }
  if (en.identity?.editorialStrategy && next.identity.editorialStrategy.provenance === 'DEFAULT') {
    next.identity.editorialStrategy = field(String(en.identity.editorialStrategy).trim(), 'INFERRED');
  }
  if (en.identity?.audience && next.identity.audience.provenance === 'DEFAULT') {
    next.identity.audience = field(String(en.identity.audience).trim(), 'INFERRED');
  }
  if (en.visual?.visualStyleLine && next.visual.visualStyleLine.provenance === 'DEFAULT') {
    next.visual.visualStyleLine = field(String(en.visual.visualStyleLine).trim(), 'INFERRED');
  }
  if (Array.isArray(en.negativePrompts) && en.negativePrompts.length > 0) {
    for (const neg of en.negativePrompts) {
      if (!next.visual.negativePrompts.includes(String(neg).trim())) {
        next.visual.negativePrompts.push(String(neg).trim());
      }
    }
  }
  if (Array.isArray(en.bannedWords) && en.bannedWords.length > 0) {
    for (const bw of en.bannedWords) {
      if (!next.rules.bannedWords.includes(String(bw).trim())) {
        next.rules.bannedWords.push(String(bw).trim());
      }
    }
  }
  if (en.brandName && (!next.identity.channelName.value || next.identity.channelName.provenance === 'DEFAULT')) {
    next.identity.channelName = field(String(en.brandName).trim(), 'INFERRED');
  }
  if (en.persona && next.identity.persona.provenance === 'DEFAULT') {
    next.identity.persona = field(String(en.persona).trim(), 'INFERRED');
  }

  return next;
}

export interface MasterPromptProfileSummary {
  channel: string;
  niche: string;
  language: string;
  wordBudget: string;
  estimatedRuntime: string;
  chaptersCount: number;
  recommendedMode: GenerationMode | null;
  cuts: string;
  text: string;
  toString(): string;
}

/**
 * Produces a concise human-readable summary of the profile for UI chips and inspector cards.
 */
export function summariseProfile(profile: MasterPromptProfile): MasterPromptProfileSummary {
  const parts: string[] = [];
  const chName = profile.identity.channelName.value || '';
  const spoken = profile.identity.spokenChannelName.value || '';
  const channelDisplay =
    chName && spoken && spoken !== chName ? `${chName} (${spoken})` : chName || 'FactLock';

  if (channelDisplay) {
    parts.push(`Channel: ${channelDisplay}`);
  }
  if (profile.identity.niche.value) {
    parts.push(`Niche: ${profile.identity.niche.value}`);
  }
  parts.push(
    `Language: ${profile.language.uiLanguage.value} (${profile.language.script.value})`
  );
  const wordBudget = `${profile.budget.wordBudgetMin.value.toLocaleString()}–${profile.budget.wordBudgetMax.value.toLocaleString()} words`;
  const estimatedRuntime = `~${profileTargetMinutes(profile)} min`;
  const cuts = `${profile.pacing.cutMinSec.value.toFixed(1)}s – ${profile.pacing.cutMaxSec.value.toFixed(1)}s`;

  parts.push(
    `Budget: ${wordBudget} (${estimatedRuntime} @ ${profile.budget.wpm.value} WPM)`
  );
  if (profile.chapters.length > 0) {
    parts.push(`Chapters: ${profile.chapters.length}`);
  }
  if (profile.pacing.recommendedMode.value) {
    parts.push(`Mode: ${profile.pacing.recommendedMode.value}`);
  }

  const text = parts.join(' • ');

  return {
    channel: channelDisplay,
    niche: profile.identity.niche.value,
    language: `${profile.language.uiLanguage.value} (${profile.language.script.value})`,
    wordBudget,
    estimatedRuntime,
    chaptersCount: profile.chapters.length,
    recommendedMode: profile.pacing.recommendedMode.value,
    cuts,
    text,
    toString() {
      return text;
    },
  };
}
