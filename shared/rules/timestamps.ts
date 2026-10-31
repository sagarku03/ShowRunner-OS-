export type TagStyle = 'bracketed' | 'plain';

export interface TimestampFormatOptions {
  tagStyle?: TagStyle;
  isMs?: boolean;
}

/**
 * Formats seconds or integer milliseconds into canonical PRD format:
 * `#[MM-SS.mmm]` (or `#MM-SS.mmm` if plain style).
 * Hyphen between minutes and seconds, exactly 3 ms digits, '#' prefix, zero colons.
 * Built from INTEGER milliseconds so 59.9996 s -> #[01-00.000], never #[00-60.000].
 * Minutes can exceed 59 (e.g. 4503.45 s -> #[75-03.450]); no hours field.
 */
export function formatTimestampTag(
  val: number,
  optionsOrStyle?: TagStyle | TimestampFormatOptions | boolean,
  explicitIsMs?: boolean
): string {
  let style: TagStyle = 'bracketed';
  let isMs: boolean | undefined = explicitIsMs;

  if (typeof optionsOrStyle === 'string') {
    style = optionsOrStyle;
  } else if (typeof optionsOrStyle === 'boolean') {
    isMs = optionsOrStyle;
  } else if (typeof optionsOrStyle === 'object' && optionsOrStyle !== null) {
    if (optionsOrStyle.tagStyle) style = optionsOrStyle.tagStyle;
    if (typeof optionsOrStyle.isMs === 'boolean') isMs = optionsOrStyle.isMs;
  }

  const safeVal = Math.max(0, Number.isFinite(val) ? val : 0);
  let totalMs: number;

  if (isMs === true) {
    totalMs = Math.round(safeVal);
  } else if (isMs === false) {
    totalMs = Math.round(safeVal * 1000);
  } else {
    // Auto-detect seconds vs milliseconds:
    // If it has decimal places (e.g. 59.9996, 4503.45, 0.0004), it is seconds.
    // If it is >= 100_000, it is milliseconds (100_000 s is 27.7 hours, exceeding video length).
    // ShowRunner max runtime is 2 hours (7200 s). If an integer is > 7200, it's ms.
    // If an integer <= 7200, it's seconds by default when not specified.
    if (!Number.isInteger(safeVal)) {
      totalMs = Math.round(safeVal * 1000);
    } else if (safeVal > 7200) {
      totalMs = Math.round(safeVal);
    } else {
      totalMs = Math.round(safeVal * 1000);
    }
  }

  const mm = Math.floor(totalMs / 60000);
  const remMs = totalMs % 60000;
  const ss = Math.floor(remMs / 1000);
  const mmm = remMs % 1000;

  const mmStr = String(mm).padStart(2, '0');
  const ssStr = String(ss).padStart(2, '0');
  const mmmStr = String(mmm).padStart(3, '0');
  const core = `${mmStr}-${ssStr}.${mmmStr}`;

  return style === 'plain' ? `#${core}` : `#[${core}]`;
}

/**
 * Human display label only: "MM:SS.mmm → MM:SS.mmm" (e.g. "01:23.450 → 01:27.100").
 * Never used in prompts or exported filenames.
 */
export function formatRangeLabel(
  startInput: number,
  endInput: number,
  isMs?: boolean
): string {
  const fmt = (val: number): string => {
    const safe = Math.max(0, Number.isFinite(val) ? val : 0);
    let ms: number;
    if (isMs === true) {
      ms = Math.round(safe);
    } else if (isMs === false || !Number.isInteger(safe)) {
      ms = Math.round(safe * 1000);
    } else if (safe > 7200) {
      ms = Math.round(safe);
    } else {
      ms = Math.round(safe * 1000);
    }

    const mm = Math.floor(ms / 60000);
    const rem = ms % 60000;
    const ss = Math.floor(rem / 1000);
    const mmm = rem % 1000;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(mmm).padStart(3, '0')}`;
  };

  return `${fmt(startInput)} → ${fmt(endInput)}`;
}

/**
 * Parses timestamp string into integer milliseconds.
 */
export function parseTimestampToMs(raw: string): number {
  return Math.round(parseTimestampToSeconds(raw) * 1000);
}

/**
 * Parses a timestamp string such as:
 * - "#[01-23.450]" / "#01-23.450" / "[01-23.450]" / "01-23.450"
 * - "00:01:23.450" / "01:23.450" / "01:23,450" / "83.450"
 * into decimal seconds (3 decimal digits precision).
 */
export function parseTimestampToSeconds(raw: string): number {
  const cleaned = raw.trim().replace(/^#\[?/, '').replace(/\]$/, '');

  // Check hyphen format: MM-SS.mmm
  if (/^\d{2,}-\d{2}\.\d{1,3}$/.test(cleaned)) {
    const [mmStr, ssRest] = cleaned.split('-');
    const mm = Number(mmStr);
    const ss = Number(ssRest);
    return Number((mm * 60 + ss).toFixed(3));
  }

  const normalized = cleaned.replace(',', '.');
  const parts = normalized.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid timestamp: "${raw}"`);
  }
  if (parts.length === 3) {
    return Number((parts[0] * 3600 + parts[1] * 60 + parts[2]).toFixed(3));
  }
  if (parts.length === 2) {
    return Number((parts[0] * 60 + parts[1]).toFixed(3));
  }
  if (parts.length === 1) {
    return Number(parts[0].toFixed(3));
  }
  throw new Error(`Unsupported timestamp format: "${raw}"`);
}
