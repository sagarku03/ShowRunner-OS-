import {
  normaliseEnglishSpoken,
  numberToEnglishWords,
  replaceDigitsInEnglishProse,
} from './englishNumbers.ts';

export { normaliseEnglishSpoken, numberToEnglishWords, replaceDigitsInEnglishProse };

/**
 * Deterministic Hindi Number, Decimal, Percentage & Currency Normalizer (0..99,99,99,999)
 * Eliminates all Arabic digits (0-9) and Devanagari digits (०-९) into spoken Devanagari words,
 * expands $ / ₹ / % currencies and symbols, prepends vocal breath pauses `, `,
 * and flags any residual Latin tokens [A-Za-z] for Box 2 TTS validation (G10).
 */

const ZERO_TO_NINETEEN: ReadonlyArray<string> = [
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
  'सोलह',
  'सत्रह',
  'अठारह',
  'उन्नीस',
  'बीस',
  'इक्कीस',
  'बाईस',
  'तेईस',
  'चौबीस',
  'पच्चीस',
  'छब्बीस',
  'सत्ताईस',
  'अट्ठाईस',
  'उनतीस',
  'तीस',
  'इकतीस',
  'बत्तीस',
  'तैंतीस',
  'चौंतीस',
  'पैंतीस',
  'छत्तीस',
  'सैंतीस',
  'अड़तीस',
  'उनतालीस',
  'चालीस',
  'इकतालीस',
  'बयालीस',
  'तैंतालीस',
  'चवालीस',
  'पैंतालीस',
  'छियालीस',
  'सैंतालीस',
  'अड़तालीस',
  'उनचास',
  'पचास',
  'इकावन',
  'बावन',
  'तिरपन',
  'चौवन',
  'पचपन',
  'छप्पन',
  'सत्तावन',
  'अट्ठावन',
  'उनसठ',
  'साठ',
  'इकसठ',
  'बासठ',
  'तिरसठ',
  'चौंसठ',
  'पैंसठ',
  'छियासठ',
  'सड़सठ',
  'अड़सठ',
  'उनहत्तर',
  'सत्तर',
  'इकहत्तर',
  'बहत्तर',
  'तिहत्तर',
  'चौहत्तर',
  'पचहत्तर',
  'छिहत्तर',
  'सतहत्तर',
  'अठहत्तर',
  'उनासी',
  'अस्सी',
  'इक्यासी',
  'बयासी',
  'तिरासी',
  'चौरासी',
  'पचासी',
  'छियासी',
  'सत्तासी',
  'अट्ठासी',
  'नवासी',
  'नब्बे',
  'इक्यानवे',
  'बानवे',
  'तिरानवे',
  'चौरानवे',
  'पचानवे',
  'छियानवे',
  'सत्तानवे',
  'अट्ठानवे',
  'निन्यानवे',
];

const DEVANAGARI_DIGIT_MAP: Record<string, string> = {
  '०': '0',
  '१': '1',
  '२': '2',
  '३': '3',
  '४': '4',
  '५': '5',
  '६': '6',
  '७': '7',
  '८': '8',
  '९': '9',
};

export function normalizeDevanagariDigitsToAscii(input: string): string {
  return input.replace(/[०-९]/g, (d) => DEVANAGARI_DIGIT_MAP[d] ?? d);
}

export function integerToHindiWords(num: number): string {
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid number: ${num}`);
  }
  const n = Math.floor(Math.abs(num));
  if (n < 0) {
    return `ऋण ${integerToHindiWords(n)}`;
  }
  if (n < 100) {
    return ZERO_TO_NINETEEN[n];
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rem = n % 100;
    const head = `${ZERO_TO_NINETEEN[hundreds]} सौ`;
    return rem === 0 ? head : `${head} ${integerToHindiWords(rem)}`;
  }
  if (n < 100_000) {
    const thousands = Math.floor(n / 1000);
    const rem = n % 1000;
    const head = `${integerToHindiWords(thousands)} हज़ार`;
    return rem === 0 ? head : `${head} ${integerToHindiWords(rem)}`;
  }
  if (n < 10_000_000) {
    const lakhs = Math.floor(n / 100_000);
    const rem = n % 100_000;
    const head = `${integerToHindiWords(lakhs)} लाख`;
    return rem === 0 ? head : `${head} ${integerToHindiWords(rem)}`;
  }
  const crores = Math.floor(n / 10_000_000);
  const rem = n % 10_000_000;
  const head = `${integerToHindiWords(crores)} करोड़`;
  return rem === 0 ? head : `${head} ${integerToHindiWords(rem)}`;
}

export function numberToHindiWords(value: number | string): string {
  const raw = normalizeDevanagariDigitsToAscii(String(value).replace(/,/g, '').trim());
  const isNegative = raw.startsWith('-');
  const unsigned = isNegative ? raw.slice(1) : raw;

  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    return String(value);
  }

  const [intPartStr, decPartStr] = unsigned.split('.');
  const intVal = Number.parseInt(intPartStr, 10);
  const intWords = integerToHindiWords(intVal);

  let result = intWords;
  if (decPartStr && decPartStr.length > 0) {
    const decDigits = decPartStr
      .split('')
      .map((digit) => ZERO_TO_NINETEEN[Number.parseInt(digit, 10)]);
    result = `${intWords} दशमलव ${decDigits.join(' ')}`;
  }

  return isNegative ? `ऋण ${result}` : result;
}

export function replaceDigitsInProse(text: string): string {
  const asciiNormalized = normalizeDevanagariDigitsToAscii(text);

  // 1. Expand Dollar amounts: $20 or $ 20.5 -> बीस डॉलर
  const withDollars = asciiNormalized.replace(
    /\$\s*(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?/g,
    (_m, intGroup: string, decGroup?: string) => {
      const cleanInt = intGroup.replace(/,/g, '');
      const fullNum = decGroup ? `${cleanInt}.${decGroup}` : cleanInt;
      return `${numberToHindiWords(fullNum)} डॉलर`;
    }
  );

  // 2. Expand Rupee amounts: ₹500 or ₹ 500 -> पाँच सौ रुपये
  const withRupees = withDollars.replace(
    /₹\s*(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?/g,
    (_m, intGroup: string, decGroup?: string) => {
      const cleanInt = intGroup.replace(/,/g, '');
      const fullNum = decGroup ? `${cleanInt}.${decGroup}` : cleanInt;
      return `${numberToHindiWords(fullNum)} रुपये`;
    }
  );

  // 3. Expand Percentages: 20% -> बीस प्रतिशत
  const withPercentNumbers = withRupees.replace(
    /(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?\s*%/g,
    (_m, intGroup: string, decGroup?: string) => {
      const cleanInt = intGroup.replace(/,/g, '');
      const fullNum = decGroup ? `${cleanInt}.${decGroup}` : cleanInt;
      return `${numberToHindiWords(fullNum)} प्रतिशत`;
    }
  );

  // 4. Expand remaining standalone numbers
  const withAllNumbers = withPercentNumbers.replace(
    /\b(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?\b/g,
    (fullMatch, intGroup: string, decGroup?: string) => {
      const cleanInt = intGroup.replace(/,/g, '');
      const fullNum = decGroup ? `${cleanInt}.${decGroup}` : cleanInt;
      if (cleanInt.length > 11) {
        return cleanInt
          .split('')
          .map((d) => ZERO_TO_NINETEEN[Number.parseInt(d, 10)] ?? d)
          .join(' ');
      }
      return numberToHindiWords(fullNum) || fullMatch;
    }
  );

  return withAllNumbers
    .replace(/%/g, ' प्रतिशत ')
    .replace(/\$/g, ' डॉलर ')
    .replace(/₹/g, ' रुपये ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export const SUPPORTED_UNICODE_SCRIPTS: ReadonlyArray<string> = [
  'Devanagari',
  'Latin',
  'Arabic',
  'Bengali',
  'Tamil',
  'Telugu',
  'Gujarati',
  'Kannada',
  'Malayalam',
  'Gurmukhi',
  'Cyrillic',
  'Han',
  'Hiragana',
  'Katakana',
  'Hangul',
];

export function assertSupportedLanguageScript(script: string): string {
  const trimmed = String(script || 'Devanagari').trim();
  const matched = SUPPORTED_UNICODE_SCRIPTS.find(
    (s) => s.toLowerCase() === trimmed.toLowerCase()
  );
  if (!matched) {
    const err = new Error(
      `UNSUPPORTED_LANGUAGE_SCRIPT: Script "${trimmed}" is not supported. Supported scripts: ${SUPPORTED_UNICODE_SCRIPTS.join(', ')}`
    ) as Error & { code: string; statusCode: number };
    err.code = 'UNSUPPORTED_LANGUAGE_SCRIPT';
    err.statusCode = 422;
    throw err;
  }
  return matched;
}

export function normaliseSpoken(text: string, script: string = 'Devanagari'): string {
  const canonicalScript = assertSupportedLanguageScript(script);
  if (canonicalScript === 'Latin') {
    return normaliseEnglishSpoken(text);
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return paragraphs
    .map((p) => {
      const expanded = canonicalScript === 'Devanagari' ? replaceDigitsInProse(p) : p;
      const withoutLeadingCommas = expanded.replace(/^,+\s*/, '').trim();
      return `, ${withoutLeadingCommas}`;
    })
    .join('\n\n');
}

export interface SpokenBlockValidation {
  valid: boolean;
  script: string;
  reason?: 'LATIN_TOKEN' | 'ARABIC_DIGIT' | 'MISSING_BREATH_PAUSE' | 'SCRIPT_MISMATCH';
  offendingTokens: string[];
  hasArabicDigits: boolean;
  hasLatinChars: boolean;
  missingLeadingCommaParagraphs: number[];
}

export function validateSpokenBlock(
  box2Text: string,
  script: string = 'Devanagari'
): SpokenBlockValidation {
  const canonicalScript = assertSupportedLanguageScript(script);
  const paragraphs = box2Text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const latinMatches = box2Text.match(/[A-Za-z]+/g) ?? [];
  const digitMatches = box2Text.match(/[0-9०-९]+/g) ?? [];
  const missingCommaIndices: number[] = [];

  paragraphs.forEach((p, idx) => {
    if (!p.startsWith(', ')) {
      missingCommaIndices.push(idx);
    }
  });

  if (canonicalScript === 'Devanagari' && latinMatches.length > 0) {
    return {
      valid: false,
      script: canonicalScript,
      reason: 'LATIN_TOKEN',
      offendingTokens: Array.from(new Set(latinMatches)),
      hasArabicDigits: digitMatches.length > 0,
      hasLatinChars: true,
      missingLeadingCommaParagraphs: missingCommaIndices,
    };
  }

  if (digitMatches.length > 0) {
    return {
      valid: false,
      script: canonicalScript,
      reason: 'ARABIC_DIGIT',
      offendingTokens: Array.from(new Set(digitMatches)),
      hasArabicDigits: true,
      hasLatinChars: canonicalScript === 'Devanagari' ? latinMatches.length > 0 : false,
      missingLeadingCommaParagraphs: missingCommaIndices,
    };
  }

  if (canonicalScript !== 'Devanagari' && canonicalScript !== 'Latin') {
    const scriptRegex = new RegExp(`\\p{Script=${canonicalScript}}`, 'u');
    if (box2Text.trim().length > 0 && !scriptRegex.test(box2Text)) {
      return {
        valid: false,
        script: canonicalScript,
        reason: 'SCRIPT_MISMATCH',
        offendingTokens: [`missing_${canonicalScript}_script`],
        hasArabicDigits: false,
        hasLatinChars: false,
        missingLeadingCommaParagraphs: missingCommaIndices,
      };
    }
  }

  if (missingCommaIndices.length > 0) {
    return {
      valid: false,
      script: canonicalScript,
      reason: 'MISSING_BREATH_PAUSE',
      offendingTokens: missingCommaIndices.map((i) => `paragraph_${i + 1}`),
      hasArabicDigits: false,
      hasLatinChars: false,
      missingLeadingCommaParagraphs: missingCommaIndices,
    };
  }

  return {
    valid: true,
    script: canonicalScript,
    offendingTokens: [],
    hasArabicDigits: false,
    hasLatinChars: false,
    missingLeadingCommaParagraphs: [],
  };
}
