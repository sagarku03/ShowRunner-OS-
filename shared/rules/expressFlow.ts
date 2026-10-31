import {
  resolveModelLockedPacing,
  TRANSCRIPT_FILE_MAX_BYTES,
  type GenerationMode,
  type VideoProvider,
} from '../../src/config/constants.ts';
import {
  decodeTranscriptBytes,
  type DetectedTimeUnit,
  type DetectedTranscriptFormat,
  type FullParsedTranscriptResult,
  type PrecisionGrade,
  type TranscriptFileEncoding,
} from './transcript.ts';

export interface TranscriptUploadState {
  transcriptText: string;
  fileName: string | null;
  fileSizeBytes: number | null;
  detectedEncoding: TranscriptFileEncoding | null;
  formatHint: DetectedTranscriptFormat | null;
  unitsOverride: DetectedTimeUnit | undefined;
  shouldAutoPreview: boolean;
  uploadError: {
    code: string;
    message: string;
  } | null;
}

export function createInitialTranscriptUploadState(initialText: string = ''): TranscriptUploadState {
  return {
    transcriptText: initialText,
    fileName: null,
    fileSizeBytes: null,
    detectedEncoding: null,
    formatHint: null,
    unitsOverride: undefined,
    shouldAutoPreview: false,
    uploadError: null,
  };
}

export function inferFormatHintFromFileName(fileName: string): DetectedTranscriptFormat | null {
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith('.vtt')) return 'WEBVTT';
  if (lower.endsWith('.srt')) return 'SRT';
  if (lower.endsWith('.csv')) return 'CSV';
  if (lower.endsWith('.tsv')) return 'TSV';
  if (lower.endsWith('.json')) return 'FLAT_JSON';
  if (lower.endsWith('.txt')) return 'PLAIN_TIMED_LINES';
  return null;
}

/**
 * Pure upload state transition helper (T-U2).
 * Decodes file bytes, populates transcriptText, fileName, fileSizeBytes, encoding, formatHint,
 * and triggers auto-preview without any DOM dependency.
 */
export function applyTranscriptFileUpload(
  prevState: TranscriptUploadState,
  file: { name: string; bytes: ArrayBuffer | Uint8Array },
  maxBytes: number = TRANSCRIPT_FILE_MAX_BYTES
): TranscriptUploadState {
  try {
    const decoded = decodeTranscriptBytes(file.bytes, maxBytes);
    return {
      ...prevState,
      transcriptText: decoded.text,
      fileName: file.name,
      fileSizeBytes: decoded.byteLength,
      detectedEncoding: decoded.encoding,
      formatHint: inferFormatHintFromFileName(file.name),
      shouldAutoPreview: true,
      uploadError: null,
    };
  } catch (err) {
    const typed = err as Error & { code?: string };
    return {
      ...prevState,
      shouldAutoPreview: false,
      uploadError: {
        code: typed.code || 'TRANSCRIPT_INVALID',
        message: typed.message || 'Failed to read transcript file.',
      },
    };
  }
}

export function clearTranscriptUpload(): TranscriptUploadState {
  return createInitialTranscriptUploadState('');
}

export function setTranscriptUnitsOverride(
  prevState: TranscriptUploadState,
  unitsOverride: DetectedTimeUnit | undefined
): TranscriptUploadState {
  return {
    ...prevState,
    unitsOverride,
    shouldAutoPreview: prevState.transcriptText.trim().length > 0,
  };
}

export type ExpressChecklistStepId =
  | 'GEMINI_KEY_AND_MODELS'
  | 'STYLE_LOCKED'
  | 'TRANSCRIPT_PARSED'
  | 'PACING_CHOSEN'
  | 'ESTIMATED_TIMING_CONSENT';

export interface ExpressChecklistStep {
  stepNumber: number;
  id: ExpressChecklistStepId;
  title: string;
  passed: boolean;
  required: boolean;
  summaryText: string;
  actionLabel?: string;
  actionTarget?: 'VAULT' | 'QUICK_STYLE' | 'TRANSCRIPT' | 'PACING' | 'CONSENT';
}

export interface ExpressChecklistInput {
  hasValidGeminiKeyAndModels: boolean;
  hasLockedStyle: boolean;
  styleSource?: string | null;
  parsedPreview: FullParsedTranscriptResult | null;
  previewErrorCode?: string | null;
  generationMode: GenerationMode | null;
  videoProvider?: VideoProvider | null;
  defaultClipDuration?: number | null;
  confirmEstimated: boolean;
}

export interface ExpressChecklistEvaluation {
  steps: ExpressChecklistStep[];
  firstUnmetStep: ExpressChecklistStep | null;
  canLock: boolean;
  primaryButtonLabel: string;
  disabledReason: string | null;
  pacingBounds: {
    minSec: number;
    maxSec: number;
    targetSec: number;
    ruleLabel: string;
  } | null;
}

/**
 * Pure 5-step checklist evaluator for the Express Import Stepper (X1 / T-X1).
 * Ensures the primary button text and state follow the first unmet step and is NEVER disabled
 * without a visible reason line directly above it.
 */
export function evaluateExpressChecklist(input: ExpressChecklistInput): ExpressChecklistEvaluation {
  const grade: PrecisionGrade | null = input.parsedPreview?.meta.precisionGrade ?? null;
  const requiresConsent = grade === 'CUE_INTERPOLATED';

  // Evaluate step 4 pacing bounds from model-locked table
  let pacingValid = false;
  let pacingBounds: ExpressChecklistEvaluation['pacingBounds'] = null;
  if (input.generationMode) {
    try {
      const rule = resolveModelLockedPacing({
        mode: input.generationMode,
        provider: input.videoProvider ?? undefined,
        durationSec: input.defaultClipDuration ?? undefined,
      });
      pacingValid = true;
      const midSec = Number(((rule.minSec + rule.maxSec) / 2).toFixed(1));
      pacingBounds = {
        minSec: rule.minSec,
        maxSec: rule.maxSec,
        targetSec: midSec,
        ruleLabel: `${rule.minSec}s–${rule.maxSec}s (target ${midSec}s)`,
      };
    } catch {
      pacingValid = false;
    }
  }

  const transcriptPassed = Boolean(
    input.parsedPreview &&
      !input.previewErrorCode &&
      input.parsedPreview.meta.metrology.wordCount >= 50 &&
      input.parsedPreview.meta.metrology.lockedRuntimeSec >= 20
  );

  const meta = input.parsedPreview?.meta;
  const transcriptSummary = transcriptPassed && meta
    ? `${meta.format} • ${meta.units} • ${meta.precisionGrade} • ${meta.metrology.wordCount} words • ${meta.metrology.lockedRuntimeSec.toFixed(1)}s • ${meta.metrology.actualWpm} WPM`
    : input.previewErrorCode
      ? `Blocked: ${input.previewErrorCode}`
      : 'Upload a file or paste transcript to parse';

  const worstCaseMs = meta?.worstCaseCueErrorMs ?? 600;

  const steps: ExpressChecklistStep[] = [
    {
      stepNumber: 1,
      id: 'GEMINI_KEY_AND_MODELS',
      title: 'Valid Gemini key + models',
      passed: input.hasValidGeminiKeyAndModels,
      required: true,
      summaryText: input.hasValidGeminiKeyAndModels
        ? 'Active API key & validated models ready'
        : 'Missing active Gemini key or usable models',
      actionLabel: 'Open Vault',
      actionTarget: 'VAULT',
    },
    {
      stepNumber: 2,
      id: 'STYLE_LOCKED',
      title: 'Style locked (Channel DNA or Quick Style)',
      passed: input.hasLockedStyle,
      required: true,
      summaryText: input.hasLockedStyle
        ? `Style locked (${input.styleSource || 'DNA'})`
        : 'Default style – set DNA or Quick Style to lock',
      actionLabel: 'Quick Style',
      actionTarget: 'QUICK_STYLE',
    },
    {
      stepNumber: 3,
      id: 'TRANSCRIPT_PARSED',
      title: 'Transcript parsed (≥ 50 words & ≥ 20s)',
      passed: transcriptPassed,
      required: true,
      summaryText: transcriptSummary,
      actionLabel: 'Check Transcript',
      actionTarget: 'TRANSCRIPT',
    },
    {
      stepNumber: 4,
      id: 'PACING_CHOSEN',
      title: 'Generation mode + engine + duration chosen',
      passed: pacingValid,
      required: true,
      summaryText: pacingBounds
        ? `${input.generationMode === 'MODE_1_IMAGE' || input.generationMode === 'MODE_1' ? 'Mode 1 (Image-First)' : `Mode 2 (${input.videoProvider || 'VEO'} ${input.defaultClipDuration || 8}s)`} • Slot bounds ${pacingBounds.ruleLabel}`
        : 'Select generation mode, engine, and clip duration',
      actionLabel: 'Choose Pacing',
      actionTarget: 'PACING',
    },
  ];

  if (requiresConsent) {
    steps.push({
      stepNumber: 5,
      id: 'ESTIMATED_TIMING_CONSENT',
      title: `Estimated-timing confirmation (±${worstCaseMs} ms)`,
      passed: input.confirmEstimated,
      required: true,
      summaryText: input.confirmEstimated
        ? `Confirmed cue-interpolated word timings (±${worstCaseMs} ms)`
        : `Confirm that word times are estimated from cue boundaries (±${worstCaseMs} ms)`,
      actionLabel: 'Confirm Below',
      actionTarget: 'CONSENT',
    });
  }

  const firstUnmetStep = steps.find((s) => s.required && !s.passed) ?? null;

  if (!firstUnmetStep) {
    return {
      steps,
      firstUnmetStep: null,
      canLock: true,
      primaryButtonLabel: 'Lock Transcript & Metrology',
      disabledReason: null,
      pacingBounds,
    };
  }

  const buttonMap: Record<ExpressChecklistStepId, { label: string; reason: string }> = {
    GEMINI_KEY_AND_MODELS: {
      label: 'Fix: Validate Gemini Key in Vault first',
      reason: 'Step 1 incomplete: Add and validate a Gemini API key in Vault before locking.',
    },
    STYLE_LOCKED: {
      label: 'Fix: Lock a style first',
      reason: 'Step 2 incomplete: Lock Quick Style or Channel DNA before locking transcript.',
    },
    TRANSCRIPT_PARSED: {
      label: 'Fix: Upload or paste a valid transcript first',
      reason: input.previewErrorCode
        ? `Step 3 incomplete (${input.previewErrorCode}): Resolve transcript validation error above.`
        : 'Step 3 incomplete: Provide a valid timed transcript (at least 50 words and 20s).',
    },
    PACING_CHOSEN: {
      label: 'Fix: Choose mode, engine & duration first',
      reason: 'Step 4 incomplete: Select a valid generation mode, video provider, and clip duration.',
    },
    ESTIMATED_TIMING_CONSENT: {
      label: 'Fix: Confirm estimated timings first',
      reason: `Step 5 incomplete: Check the box confirming word times are estimated (±${worstCaseMs} ms).`,
    },
  };

  const mapped = buttonMap[firstUnmetStep.id];

  return {
    steps,
    firstUnmetStep,
    canLock: false,
    primaryButtonLabel: mapped.label,
    disabledReason: mapped.reason,
    pacingBounds,
  };
}

export type InlineFixActionType =
  | 'OPEN_QUICK_STYLE'
  | 'OPEN_VAULT'
  | 'EDIT_TRANSCRIPT'
  | 'HIGHLIGHT_OFFENDING_WORD'
  | 'SELECT_TIME_UNITS'
  | 'CONFIRM_ESTIMATED_TIMINGS'
  | 'RERUN_UPSTREAM_STAGE';

export interface InlineFixCardModel {
  code: string;
  title: string;
  description: string;
  actionType: InlineFixActionType;
  actionButtonLabel: string;
  offendingIndex?: number;
  stageNumber?: number;
}

/**
 * Pure mapper from typed gate / transcript error codes to inline fix card definitions (X2 / T-X2).
 */
export function mapErrorToInlineFixCard(
  error: {
    code?: string;
    message?: string;
    offendingIndex?: number;
    stage?: number;
  } | null
): InlineFixCardModel | null {
  if (!error || (!error.code && !error.message)) return null;

  const rawCode = error.code || '';
  const msg = error.message || '';

  const effectiveCode =
    rawCode ||
    (msg.includes('GATE_DNA_NOT_LOCKED')
      ? 'GATE_DNA_NOT_LOCKED'
      : msg.includes('NO_ACTIVE_API_KEY')
        ? 'NO_ACTIVE_API_KEY'
        : msg.includes('NO_USABLE_MODEL')
          ? 'NO_USABLE_MODEL'
          : msg.includes('TRANSCRIPT_TOO_SHORT')
            ? 'TRANSCRIPT_TOO_SHORT'
            : msg.includes('TRANSCRIPT_UNITS_AMBIGUOUS')
              ? 'TRANSCRIPT_UNITS_AMBIGUOUS'
              : msg.includes('ESTIMATED_TIMINGS_UNCONFIRMED')
                ? 'ESTIMATED_TIMINGS_UNCONFIRMED'
                : msg.includes('UPSTREAM_STAGE_DIRTY')
                  ? 'UPSTREAM_STAGE_DIRTY'
                  : msg.includes('PREREQUISITE_STAGE_')
                    ? 'PREREQUISITE_STAGE_MISSING'
                    : msg.includes('TRANSCRIPT_INVALID')
                      ? 'TRANSCRIPT_INVALID'
                      : 'TRANSCRIPT_INVALID');

  // Extract offending index from message if not explicitly passed
  let offendingIndex = error.offendingIndex;
  if (typeof offendingIndex !== 'number') {
    const idxMatch = msg.match(/(?:index|offending index)\s+(\d+)/i);
    if (idxMatch) {
      offendingIndex = Number(idxMatch[1]);
    }
  }

  switch (effectiveCode) {
    case 'GATE_DNA_NOT_LOCKED':
      return {
        code: 'GATE_DNA_NOT_LOCKED',
        title: 'Channel Style Not Locked',
        description: msg || 'A locked Channel DNA or Quick Style profile is required before running this stage.',
        actionType: 'OPEN_QUICK_STYLE',
        actionButtonLabel: 'Open Quick Style Sheet',
      };

    case 'NO_ACTIVE_API_KEY':
    case 'NO_USABLE_MODEL':
      return {
        code: effectiveCode,
        title: effectiveCode === 'NO_ACTIVE_API_KEY' ? 'No Active Gemini API Key' : 'No Usable Gemini Model Verified',
        description: msg || 'Configure and validate your Gemini API key in the Security Vault to unlock generation.',
        actionType: 'OPEN_VAULT',
        actionButtonLabel: 'Open API Vault',
      };

    case 'TRANSCRIPT_TOO_SHORT':
      return {
        code: 'TRANSCRIPT_TOO_SHORT',
        title: 'Transcript Too Short for Express Mode',
        description: msg || 'Express Mode requires at least 50 spoken words and 20.0 seconds of audio runtime.',
        actionType: 'EDIT_TRANSCRIPT',
        actionButtonLabel: 'Edit or Upload Full Transcript',
      };

    case 'TRANSCRIPT_UNITS_AMBIGUOUS':
      return {
        code: 'TRANSCRIPT_UNITS_AMBIGUOUS',
        title: 'Ambiguous Timestamp Units',
        description: msg || 'Numeric timestamps could be either seconds or milliseconds. Choose the correct unit below.',
        actionType: 'SELECT_TIME_UNITS',
        actionButtonLabel: 'Select Time Units (Seconds / Milliseconds)',
      };

    case 'ESTIMATED_TIMINGS_UNCONFIRMED':
      return {
        code: 'ESTIMATED_TIMINGS_UNCONFIRMED',
        title: 'Estimated Cue Timings Require Confirmation',
        description: msg || 'This transcript uses cue-interpolated word times (CUE_INTERPOLATED). Confirm the estimation tolerance before locking.',
        actionType: 'CONFIRM_ESTIMATED_TIMINGS',
        actionButtonLabel: 'Confirm Estimated Timings',
      };

    case 'UPSTREAM_STAGE_DIRTY':
    case 'PREREQUISITE_STAGE_MISSING':
    case 'PREREQUISITE_STAGE_NOT_PASSED':
      return {
        code: effectiveCode,
        title: 'Upstream Stage Prerequisite Unmet',
        description: msg || 'An upstream stage is missing or was modified after this stage ran.',
        actionType: 'RERUN_UPSTREAM_STAGE',
        actionButtonLabel: 'Go to Prerequisite Stage',
        stageNumber: error.stage,
      };

    case 'TRANSCRIPT_FILE_TOO_LARGE':
    case 'TRANSCRIPT_FILE_EMPTY':
    case 'TRANSCRIPT_FILE_NOT_TEXT':
      return {
        code: effectiveCode,
        title: 'Transcript File Upload Rejected',
        description: msg,
        actionType: 'EDIT_TRANSCRIPT',
        actionButtonLabel: 'Choose Another Transcript File',
      };

    case 'TRANSCRIPT_INVALID':
    default:
      return {
        code: effectiveCode,
        title: typeof offendingIndex === 'number'
          ? `Invalid Timestamp at Word #${offendingIndex}`
          : 'Invalid Transcript Format or Timestamps',
        description: msg || 'One or more word timestamps are non-monotonic, negative, or malformed.',
        actionType: typeof offendingIndex === 'number' ? 'HIGHLIGHT_OFFENDING_WORD' : 'EDIT_TRANSCRIPT',
        actionButtonLabel:
          typeof offendingIndex === 'number'
            ? `Jump to Offending Word #${offendingIndex}`
            : 'Focus Transcript Editor',
        offendingIndex,
      };
  }
}
