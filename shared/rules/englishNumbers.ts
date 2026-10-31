/**
 * Deterministic English Number, Decimal, Percentage & Currency Normalizer
 * Example: 187.41 -> "one hundred eighty-seven point four one"
 */

const ONES: ReadonlyArray<string> = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS: ReadonlyArray<string> = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

export function integerToEnglishWords(num: number): string {
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid number: ${num}`);
  }
  if (num < 0) {
    return `minus ${integerToEnglishWords(Math.abs(num))}`;
  }
  const n = Math.floor(num);
  if (n < 20) {
    return ONES[n];
  }
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r === 0 ? TENS[t] : `${TENS[t]}-${ONES[r]}`;
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    const head = `${ONES[h]} hundred`;
    return r === 0 ? head : `${head} ${integerToEnglishWords(r)}`;
  }
  if (n < 1_000_000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    const head = `${integerToEnglishWords(th)} thousand`;
    return r === 0 ? head : `${head} ${integerToEnglishWords(r)}`;
  }
  if (n < 1_000_000_000) {
    const m = Math.floor(n / 1_000_000);
    const r = n % 1_000_000;
    const head = `${integerToEnglishWords(m)} million`;
    return r === 0 ? head : `${head} ${integerToEnglishWords(r)}`;
  }
  const b = Math.floor(n / 1_000_000_000);
  const r = n % 1_000_000_000;
  const head = `${integerToEnglishWords(b)} billion`;
  return r === 0 ? head : `${head} ${integerToEnglishWords(r)}`;
}

export function numberToEnglishWords(value: number | string): string {
  const raw = String(value).replace(/,/g, '').trim();
  const isNegative = raw.startsWith('-');
  const unsigned = isNegative ? raw.slice(1) : raw;

  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    return String(value);
  }

  const [intPartStr, decPartStr] = unsigned.split('.');
  const intVal = Number.parseInt(intPartStr, 10);
  const intWords = integerToEnglishWords(intVal);

  let result = intWords;
  if (decPartStr && decPartStr.length > 0) {
    const decDigits = decPartStr
      .split('')
      .map((digit) => ONES[Number.parseInt(digit, 10)]);
    result = `${intWords} point ${decDigits.join(' ')}`;
  }

  return isNegative ? `minus ${result}` : result;
}

export function replaceDigitsInEnglishProse(text: string): string {
  // 1. Expand Dollar amounts: $20 -> twenty dollars
  const withDollars = text.replace(
    /\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g,
    (_m, intGroup: string, decGroup?: string) => {
      const cleanInt = intGroup.replace(/,/g, '');
      const fullNum = decGroup ? `${cleanInt}.${decGroup}` : cleanInt;
      return `${numberToEnglishWords(fullNum)} dollars`;
    }
  );

  // 2. Expand Rupee amounts: ₹500 -> five hundred rupees
  const withRupees = withDollars.replace(
    /₹\s*(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?/g,
    (_m, intGroup: string, decGroup?: string) => {
      const cleanInt = intGroup.replace(/,/g, '');
      const fullNum = decGroup ? `${cleanInt}.${decGroup}` : cleanInt;
      return `${numberToEnglishWords(fullNum)} rupees`;
    }
  );

  // 3. Expand Percentages: 20% -> twenty percent
  const withPercent = withRupees.replace(
    /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*%/g,
    (_m, intGroup: string, decGroup?: string) => {
      const cleanInt = intGroup.replace(/,/g, '');
      const fullNum = decGroup ? `${cleanInt}.${decGroup}` : cleanInt;
      return `${numberToEnglishWords(fullNum)} percent`;
    }
  );

  // 4. Expand remaining standalone numbers
  const withAllNumbers = withPercent.replace(
    /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\b/g,
    (fullMatch, intGroup: string, decGroup?: string) => {
      const cleanInt = intGroup.replace(/,/g, '');
      const fullNum = decGroup ? `${cleanInt}.${decGroup}` : cleanInt;
      if (cleanInt.length > 12) {
        return cleanInt
          .split('')
          .map((d) => ONES[Number.parseInt(d, 10)] ?? d)
          .join(' ');
      }
      return numberToEnglishWords(fullNum) || fullMatch;
    }
  );

  return withAllNumbers
    .replace(/%/g, ' percent ')
    .replace(/\$/g, ' dollars ')
    .replace(/₹/g, ' rupees ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function normaliseEnglishSpoken(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return paragraphs
    .map((p) => {
      const expanded = replaceDigitsInEnglishProse(p);
      const withoutLeadingCommas = expanded.replace(/^,+\s*/, '').trim();
      return `, ${withoutLeadingCommas}`;
    })
    .join('\n\n');
}
