import React, { useEffect, useRef, useState } from 'react';
import {
  FileText,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Wrench,
  Edit3,
  Clock,
  RotateCcw,
  Film,
  Copy,
  Eye,
  Dna,
  Upload,
  Trash2,
  KeyRound,
  ArrowRight,
  Zap,
  CheckSquare,
  Square,
  FileUp,
} from 'lucide-react';
import type { GenerationMode, VideoProvider } from '../config/constants.ts';
import {
  ANDROID_SAFE_SCRIPT_ACCEPT,
  ANDROID_SAFE_TRANSCRIPT_ACCEPT,
  NEUTRAL_LIGHTING,
  OMNI_FLASH_DURATIONS,
  QUICK_STYLE_VISUAL_PRESETS,
  resolveModelLockedPacing,
  VEO_3_1_FIXED_DURATION,
} from '../config/constants.ts';
import {
  applyTranscriptFileUpload,
  clearTranscriptUpload,
  createInitialTranscriptUploadState,
  evaluateExpressChecklist,
  mapErrorToInlineFixCard,
  setTranscriptUnitsOverride,
  type InlineFixCardModel,
  type TranscriptUploadState,
} from '../../shared/rules/expressFlow.ts';
import {
  decodeTranscriptBytes,
  type DetectedTimeUnit,
  type FullParsedTranscriptResult,
} from '../../shared/rules/transcript.ts';
import type {
  ChannelDnaRecord,
  HubId,
  PipelineStateVector,
  ProjectItem,
  S3StagePayload,
  S4StagePayload,
  S5StagePayload,
} from '../types/showrunner.ts';
import { ApiClientError, apiRequest } from '../utils/apiClient.ts';

interface ScriptHubProps {
  activeProject: ProjectItem | null;
  stateVector: PipelineStateVector | null;
  channelDna?: ChannelDnaRecord | null;
  hasValidKey?: boolean;
  hasSelectedModel?: boolean;
  onRefreshState: () => Promise<void>;
  onNavigateHub?: (hub: HubId) => void;
  onNotify: (msg: string, tone?: 'success' | 'warn' | 'error', err?: unknown) => void;
}


export const ScriptHub: React.FC<ScriptHubProps> = ({
  activeProject,
  stateVector,
  channelDna = null,
  hasValidKey = false,
  hasSelectedModel = false,
  onRefreshState,
  onNavigateHub,
  onNotify,
}) => {
  const rawS3 = (stateVector?.context?.S3?.payload as S3StagePayload | null) ?? null;
  const s3Payload =
    rawS3 && (typeof rawS3.box1Text === 'string' || Array.isArray(rawS3.paragraphs))
      ? rawS3
      : null;

  const rawS4 = (stateVector?.context?.S4?.payload as S4StagePayload | null) ?? null;
  const s4Payload =
    rawS4 && Array.isArray(rawS4.words) && typeof rawS4.actualDurationSec === 'number'
      ? rawS4
      : null;

  const rawS5 = (stateVector?.context?.S5?.payload as S5StagePayload | null) ?? null;
  const s5Payload = rawS5 && Array.isArray(rawS5.slots) ? rawS5 : null;

  const [activeBox, setActiveBox] = useState<'box1' | 'box2' | 'paragraphs'>('box1');
  const [generatingScript, setGeneratingScript] = useState(false);
  const [repairingScript, setRepairingScript] = useState(false);

  const [editingParaIdx, setEditingParaIdx] = useState<number | null>(null);
  const [manualParaText, setManualParaText] = useState('');

  // U1: Transcript Upload & Paste State
  const [uploadState, setUploadState] = useState<TranscriptUploadState>(() =>
    createInitialTranscriptUploadState('')
  );
  const [transcriptInput, setTranscriptInput] = useState('');
  const [optionalScriptText, setOptionalScriptText] = useState('');
  const [scriptFileName, setScriptFileName] = useState<string | null>(null);
  const [actualSecInput, setActualSecInput] = useState<string>('');
  const [dragActive, setDragActive] = useState(false);

  const transcriptFileInputRef = useRef<HTMLInputElement | null>(null);
  const scriptFileInputRef = useRef<HTMLInputElement | null>(null);
  const storyboardSectionRef = useRef<HTMLElement | null>(null);
  const previewTableRef = useRef<HTMLDivElement | null>(null);

  // X1/X4/X5: Preview, Checklist, Pacing, Consent, Inline Fix Card
  const [previewing, setPreviewing] = useState(false);
  const [parsedPreview, setParsedPreview] = useState<FullParsedTranscriptResult | null>(null);
  const [confirmEstimated, setConfirmEstimated] = useState(false);
  const [inlineFixCard, setInlineFixCard] = useState<InlineFixCardModel | null>(null);
  const [highlightedWordIdx, setHighlightedWordIdx] = useState<number | null>(null);

  // X1 Step 4: Inline Pacing Controls
  const [generationMode, setGenerationMode] = useState<GenerationMode>(
    activeProject?.generationMode ?? 'MODE_2_VIDEO'
  );
  const [videoProvider, setVideoProvider] = useState<VideoProvider>(
    activeProject?.videoProvider ?? 'VEO_3_1'
  );
  const [clipDuration, setClipDuration] = useState<number>(
    activeProject?.defaultClipDuration ?? VEO_3_1_FIXED_DURATION
  );
  const [savingPacing, setSavingPacing] = useState(false);

  // X3: Inline Quick Style Sheet state
  const [showQuickStyleSheet, setShowQuickStyleSheet] = useState(false);
  const [quickNiche, setQuickNiche] = useState(
    activeProject?.niche || 'General Creator Channel'
  );
  const [quickFormatPreset, setQuickFormatPreset] = useState<
    'EXPLAINER' | 'DOCUMENTARY' | 'STORYTIME' | 'LISTICLE'
  >('EXPLAINER');
  const [quickLanguage, setQuickLanguage] = useState<'hi' | 'en' | 'es'>('hi');
  const [quickScript, setQuickScript] = useState<'Devanagari' | 'Latin'>('Devanagari');
  const [userTouchedLang, setUserTouchedLang] = useState(false);
  const [quickVisualStyle, setQuickVisualStyle] = useState<string>(NEUTRAL_LIGHTING);
  const [quickBrandName, setQuickBrandName] = useState<string>(
    activeProject?.brandName || ''
  );
  const [quickStylePrefix, setQuickStylePrefix] = useState('');
  const [quickNegativePrompts, setQuickNegativePrompts] = useState(
    'blurry, cartoon, watermark'
  );
  const [lockingQuickStyle, setLockingQuickStyle] = useState(false);

  // X6: Convert FULL -> EXPRESS confirmation dialog
  const [showConvertExpressConfirm, setShowConvertExpressConfirm] = useState(false);

  // Lock & Slice state
  const [lockingTranscript, setLockingTranscript] = useState(false);
  const [lockingAndSlicing, setLockingAndSlicing] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [slicingStoryboard, setSlicingStoryboard] = useState(false);

  const isExpress =
    activeProject?.entryMode === 'EXPRESS' ||
    stateVector?.context?.S3?.status === 'EXTERNAL_PROVIDED';

  const hasLockedStyle = Boolean(
    channelDna || stateVector?.context?.S0B?.status === 'PASSED'
  );

  const isNeutralDefaultStyle =
    !hasLockedStyle ||
    channelDna?.visualDirection?.aesthetic === NEUTRAL_LIGHTING ||
    !channelDna?.visualDirection?.aesthetic;

  useEffect(() => {
    if (activeProject) {
      setGenerationMode(activeProject.generationMode ?? 'MODE_2_VIDEO');
      setVideoProvider(activeProject.videoProvider ?? 'VEO_3_1');
      setClipDuration(activeProject.defaultClipDuration ?? VEO_3_1_FIXED_DURATION);
      setQuickNiche(activeProject.niche || 'General Creator Channel');
      setQuickBrandName(activeProject.brandName || '');
    }
  }, [activeProject]);

  // X3: Prefill Quick Style language/script from detected transcript script
  useEffect(() => {
    if (!userTouchedLang && parsedPreview?.meta.detectedLanguage) {
      const det = parsedPreview.meta.detectedLanguage;
      setQuickLanguage((det.primary as 'hi' | 'en' | 'es') || 'hi');
      setQuickScript(det.script === 'Devanagari' ? 'Devanagari' : 'Latin');
    }
  }, [parsedPreview, userTouchedLang]);

  let pacingRuleBounds: { minSec: number; maxSec: number } | null = null;
  try {
    const effectiveDur =
      videoProvider === 'VEO_3_1' ? VEO_3_1_FIXED_DURATION : clipDuration;
    const rule = resolveModelLockedPacing({
      mode: generationMode,
      provider: videoProvider,
      durationSec: effectiveDur,
    });
    pacingRuleBounds = { minSec: rule.minSec, maxSec: rule.maxSec };
  } catch {
    pacingRuleBounds = null;
  }

  const runPreviewRequest = async (
    rawText: string,
    overrideUnits?: DetectedTimeUnit,
    explicitFileName?: string | null
  ) => {
    if (!rawText.trim()) {
      setParsedPreview(null);
      return;
    }
    setPreviewing(true);
    setInlineFixCard(null);
    setHighlightedWordIdx(null);
    try {
      const effectiveUnits =
        overrideUnits !== undefined ? overrideUnits : uploadState.unitsOverride;
      const res = await apiRequest<FullParsedTranscriptResult>(
        '/api/v1/stage/4/transcript/preview',
        {
          method: 'POST',
          body: {
            transcript: rawText.trim(),
            fileName: explicitFileName ?? uploadState.fileName ?? undefined,
            fileSizeBytes: uploadState.fileSizeBytes ?? undefined,
            unitsOverride: effectiveUnits ?? undefined,
            scriptText: optionalScriptText.trim() || undefined,
          },
        }
      );
      setParsedPreview(res);
      if (res.meta.precisionGrade !== 'CUE_INTERPOLATED') {
        setConfirmEstimated(false);
      }
      if (!userTouchedLang && res.meta.detectedLanguage) {
        setQuickLanguage((res.meta.detectedLanguage.primary as 'hi' | 'en' | 'es') || 'hi');
        setQuickScript(res.meta.detectedLanguage.script === 'Devanagari' ? 'Devanagari' : 'Latin');
      }
    } catch (err) {
      setParsedPreview(null);
      if (err instanceof ApiClientError) {
        const card = mapErrorToInlineFixCard({
          code: err.code,
          message: err.userMessage || err.message,
        });
        setInlineFixCard(card);
        if (card?.offendingIndex !== undefined) {
          setHighlightedWordIdx(card.offendingIndex);
        }
      } else {
        const msg = (err as Error).message || 'Failed to parse transcript.';
        setInlineFixCard(mapErrorToInlineFixCard({ code: 'TRANSCRIPT_INVALID', message: msg }));
      }
    } finally {
      setPreviewing(false);
    }
  };

  // U1: Handle file selection or drop
  const handleTranscriptFileSelected = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const nextState = applyTranscriptFileUpload(uploadState, {
        name: file.name,
        bytes: new Uint8Array(buffer),
      });
      setUploadState(nextState);
      if (nextState.uploadError) {
        setParsedPreview(null);
        setInlineFixCard(
          mapErrorToInlineFixCard({
            code: nextState.uploadError.code,
            message: nextState.uploadError.message,
          })
        );
        onNotify(nextState.uploadError.message, 'error');
        return;
      }
      setTranscriptInput(nextState.transcriptText);
      setInlineFixCard(null);
      await runPreviewRequest(
        nextState.transcriptText,
        nextState.unitsOverride,
        nextState.fileName
      );
    } catch (err) {
      const msg = (err as Error).message || 'Could not read transcript file.';
      setInlineFixCard(
        mapErrorToInlineFixCard({ code: 'TRANSCRIPT_FILE_NOT_TEXT', message: msg })
      );
    }
  };

  const handleScriptFileSelected = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const decoded = decodeTranscriptBytes(new Uint8Array(buffer));
      setOptionalScriptText(decoded.text);
      setScriptFileName(file.name);
      onNotify(`Loaded original script "${file.name}"`, 'success');
      if (transcriptInput.trim()) {
        await runPreviewRequest(transcriptInput);
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleClearTranscript = () => {
    setUploadState(clearTranscriptUpload());
    setTranscriptInput('');
    setParsedPreview(null);
    setConfirmEstimated(false);
    setInlineFixCard(null);
    setHighlightedWordIdx(null);
    if (transcriptFileInputRef.current) {
      transcriptFileInputRef.current.value = '';
    }
  };

  const handleUnitsOverrideChange = async (nextUnits: DetectedTimeUnit | '') => {
    const unitVal = nextUnits === '' ? undefined : nextUnits;
    const updated = setTranscriptUnitsOverride(uploadState, unitVal);
    setUploadState(updated);
    if (transcriptInput.trim()) {
      await runPreviewRequest(transcriptInput, unitVal);
    }
  };

  const handleSaveInlinePacing = async (
    nextMode: GenerationMode,
    nextProvider: VideoProvider,
    nextDur: number
  ) => {
    const resolvedDur =
      nextProvider === 'VEO_3_1' ? VEO_3_1_FIXED_DURATION : nextDur;
    setGenerationMode(nextMode);
    setVideoProvider(nextProvider);
    setClipDuration(resolvedDur);
    if (!activeProject) return;
    setSavingPacing(true);
    try {
      await apiRequest('/api/v1/stage/0/save', {
        method: 'POST',
        body: {
          generationMode: nextMode,
          videoProvider: nextProvider,
          defaultClipDuration: resolvedDur,
        },
      });
      await onRefreshState();
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setSavingPacing(false);
    }
  };

  const handleQuickStyleLock = async () => {
    setLockingQuickStyle(true);
    try {
      await apiRequest('/api/v1/stage/0/quick-style', {
        method: 'POST',
        body: {
          niche: quickNiche.trim() || activeProject?.niche || 'General Creator Channel',
          formatPreset: quickFormatPreset,
          language: quickLanguage,
          script: quickScript,
          visualStyle: quickVisualStyle.trim() || NEUTRAL_LIGHTING,
          brandName: quickBrandName.trim() || undefined,
          stylePrefix: quickStylePrefix.trim(),
          negativePrompts: quickNegativePrompts
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          transcriptText: transcriptInput.trim() || undefined,
        },
      });
      await onRefreshState();
      setShowQuickStyleSheet(false);
      setInlineFixCard(null);
      onNotify('Quick Style locked (source: EXPRESS)', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setLockingQuickStyle(false);
    }
  };

  const handleGenerateScript = async () => {
    setGeneratingScript(true);
    try {
      await apiRequest('/api/v1/stage/3/script', { method: 'POST', body: {} });
      await onRefreshState();
      onNotify('Dual script generated & 17-point audit completed', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setGeneratingScript(false);
    }
  };

  const handleSurgicalRepair = async (paragraphIndex?: number) => {
    setRepairingScript(true);
    try {
      await apiRequest('/api/v1/stage/3/repair', {
        method: 'POST',
        body: { paragraphIndex },
      });
      await onRefreshState();
      onNotify('Surgical paragraph repair completed', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setRepairingScript(false);
    }
  };

  const handleSaveManualParagraph = async (idx: number) => {
    if (!manualParaText.trim()) return;
    setRepairingScript(true);
    try {
      await apiRequest('/api/v1/stage/3/repair', {
        method: 'POST',
        body: {
          paragraphIndex: idx,
          manualText: manualParaText.trim(),
        },
      });
      setEditingParaIdx(null);
      await onRefreshState();
      onNotify(`Paragraph #${idx + 1} updated & re-audited`, 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setRepairingScript(false);
    }
  };

  const executeLockTranscript = async (convertToExpress = false): Promise<boolean> => {
    setInlineFixCard(null);
    const sec = actualSecInput ? Number(actualSecInput) : undefined;
    try {
      await apiRequest('/api/v1/stage/4/transcript', {
        method: 'POST',
        body: {
          transcript: transcriptInput.trim() || undefined,
          fileName: uploadState.fileName ?? undefined,
          fileSizeBytes: uploadState.fileSizeBytes ?? undefined,
          unitsOverride: uploadState.unitsOverride ?? undefined,
          confirmEstimated,
          actualDurationSec: sec && sec > 0 ? sec : undefined,
          scriptText: optionalScriptText.trim() || undefined,
          entryMode: isExpress || convertToExpress ? 'EXPRESS' : undefined,
        },
      });
      await onRefreshState();
      return true;
    } catch (err) {
      if (err instanceof ApiClientError) {
        const card = mapErrorToInlineFixCard({
          code: err.code,
          message: err.userMessage || err.message,
        });
        setInlineFixCard(card);
        if (card?.offendingIndex !== undefined) {
          setHighlightedWordIdx(card.offendingIndex);
        }
      } else {
        setInlineFixCard(
          mapErrorToInlineFixCard({
            code: 'TRANSCRIPT_INVALID',
            message: (err as Error).message,
          })
        );
      }
      onNotify((err as Error).message, 'error', err);
      return false;
    }
  };

  const handleLockTranscriptSubmit = async () => {
    setLockingTranscript(true);
    try {
      const ok = await executeLockTranscript(!s3Payload);
      if (ok) {
        onNotify('Transcript locked to final word timestamp', 'success');
      }
    } finally {
      setLockingTranscript(false);
    }
  };

  const handleLockAndSliceInOneTap = async () => {
    setLockingAndSlicing(true);
    try {
      const locked = await executeLockTranscript(!s3Payload);
      if (!locked) return;
      await apiRequest('/api/v1/stage/5/storyboard', {
        method: 'POST',
        body: {},
      });
      await onRefreshState();
      onNotify('Transcript locked & storyboard sliced in one tap!', 'success');
      storyboardSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setInlineFixCard(
          mapErrorToInlineFixCard({
            code: err.code,
            message: err.userMessage || err.message,
          })
        );
      }
      onNotify((err as Error).message, 'error', err);
    } finally {
      setLockingAndSlicing(false);
    }
  };

  const handleConvertProjectToExpress = async () => {
    setShowConvertExpressConfirm(false);
    if (transcriptInput.trim()) {
      setLockingTranscript(true);
      try {
        const ok = await executeLockTranscript(true);
        if (ok) {
          onNotify('Project converted to Express Mode & transcript locked', 'success');
        }
      } finally {
        setLockingTranscript(false);
      }
    } else {
      setShowQuickStyleSheet(true);
      onNotify(
        'Upload or paste your transcript below — locking will mark S1–S3 as EXTERNAL_PROVIDED',
        'success'
      );
    }
  };

  const handleOneClickRollback = async () => {
    setRollingBack(true);
    try {
      const res = await apiRequest<{ configuredWpm: number }>('/api/v1/stage/4/rollback', {
        method: 'POST',
        body: {},
      });
      await onRefreshState();
      onNotify(`Rolled back & calibrated WPM to ${res.configuredWpm.toFixed(2)}`, 'warn');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setRollingBack(false);
    }
  };

  const handleSliceStoryboard = async () => {
    setSlicingStoryboard(true);
    try {
      await apiRequest('/api/v1/stage/5/storyboard', {
        method: 'POST',
        body: {},
      });
      await onRefreshState();
      onNotify('Storyboard slots sliced with model-locked pacing', 'success');
      storyboardSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setInlineFixCard(
          mapErrorToInlineFixCard({
            code: err.code,
            message: err.userMessage || err.message,
          })
        );
      }
      onNotify((err as Error).message, 'error', err);
    } finally {
      setSlicingStoryboard(false);
    }
  };

  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    onNotify(`${label} copied`, 'success');
  };

  // X1: Evaluate 5-step checklist
  const checklist = evaluateExpressChecklist({
    hasValidGeminiKeyAndModels: Boolean(hasValidKey && hasSelectedModel),
    hasLockedStyle,
    styleSource: channelDna?.source ?? null,
    parsedPreview,
    previewErrorCode: inlineFixCard?.code ?? null,
    generationMode,
    videoProvider,
    defaultClipDuration:
      videoProvider === 'VEO_3_1' ? VEO_3_1_FIXED_DURATION : clipDuration,
    confirmEstimated,
  });

  const handlePrimaryChecklistClick = () => {
    const target = checklist.firstUnmetStep?.actionTarget;
    if (target === 'VAULT') {
      onNavigateHub?.('vault');
      return;
    }
    if (target === 'QUICK_STYLE') {
      setShowQuickStyleSheet(true);
      return;
    }
    if (target === 'TRANSCRIPT') {
      if (transcriptInput.trim()) {
        void runPreviewRequest(transcriptInput);
      } else {
        transcriptFileInputRef.current?.click();
      }
      return;
    }
    if (target === 'CONSENT') {
      setConfirmEstimated(true);
      return;
    }
    void handleLockTranscriptSubmit();
  };

  const handleInlineFixAction = (card: InlineFixCardModel) => {
    if (card.actionType === 'OPEN_QUICK_STYLE') {
      setShowQuickStyleSheet(true);
    } else if (card.actionType === 'OPEN_VAULT') {
      onNavigateHub?.('vault');
    } else if (card.actionType === 'CONFIRM_ESTIMATED_TIMINGS') {
      setConfirmEstimated(true);
      setInlineFixCard(null);
    } else if (card.actionType === 'HIGHLIGHT_OFFENDING_WORD') {
      if (card.offendingIndex !== undefined) {
        setHighlightedWordIdx(card.offendingIndex);
        previewTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else if (card.actionType === 'EDIT_TRANSCRIPT') {
      transcriptFileInputRef.current?.click();
    }
  };

  const audit = s3Payload?.auditReport;
  const s4IsEstimated =
    s4Payload?.meta?.precisionGrade === 'CUE_INTERPOLATED' ||
    Boolean(s4Payload?.meta?.hasEstimatedWords);

  return (
    <div className="space-y-5 pb-28">
      {/* STAGE 3: DUAL SCRIPT & 17-POINT AUDIT */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Dual Script Engine</h2>
              <p className="text-xs text-slate-400">
                {isExpress
                  ? 'Express Mode: S1–S3 Bypassed (EXTERNAL_PROVIDED)'
                  : 'Box 1 Display + Box 2 TTS Phonetic'}
              </p>
            </div>
          </div>

          {isExpress ? (
            <span className="px-2.5 py-1 rounded-xl font-mono text-[11px] font-semibold bg-violet-500/20 text-violet-300 border border-violet-500/30">
              EXPRESS BYPASS
            </span>
          ) : (
            audit && (
              <span
                className={`px-2.5 py-1 rounded-xl font-mono text-[11px] font-semibold border ${
                  audit.auditStatus === 'PASSED'
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                    : audit.auditStatus === 'JUDGE_UNAVAILABLE'
                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                }`}
              >
                {audit.passedCount}/{audit.totalChecks} • {audit.auditStatus}
              </span>
            )
          )}
        </div>

        {isExpress ? (
          <div className="p-3.5 rounded-2xl bg-violet-500/10 border border-violet-500/20 text-xs text-slate-300 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span>
                Running in <strong className="text-white">Express Transcript Mode</strong>. Stages 1–3 are marked <code className="font-mono text-violet-300">EXTERNAL_PROVIDED</code>.
              </span>
              {isNeutralDefaultStyle && (
                <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono text-[10px]">
                  Default style – set DNA to customise
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowQuickStyleSheet(true)}
              className="min-h-[44px] px-3.5 py-2 rounded-xl bg-violet-500/20 hover:bg-violet-500/30 text-violet-200 border border-violet-500/30 text-xs font-semibold flex items-center gap-1.5"
            >
              <Dna className="w-4 h-4" />
              <span>{hasLockedStyle ? 'Edit Quick Style DNA' : 'Configure Quick Style DNA'}</span>
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={handleGenerateScript}
              disabled={generatingScript || !activeProject}
              className="w-full min-h-[44px] py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
            >
              <Sparkles className="w-4 h-4" />
              {generatingScript
                ? 'Synthesizing & Auditing Script...'
                : 'Generate Dual Script & Run 17-Point Audit'}
            </button>

            {/* X6: Convert FULL project to Express mode */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-[11px] text-slate-400">
                Already recorded your voiceover externally?
              </span>
              <button
                type="button"
                onClick={() => setShowConvertExpressConfirm(true)}
                className="min-h-[38px] px-3 py-1.5 rounded-xl bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 border border-violet-500/30 text-xs font-semibold flex items-center gap-1.5"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>Use my own transcript (Express)</span>
              </button>
            </div>
          </div>
        )}

        {showConvertExpressConfirm && (
          <div className="p-4 rounded-2xl bg-violet-950/60 border border-violet-500/40 space-y-3 text-xs">
            <div className="font-bold text-white flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-violet-400" />
              <span>Convert Project to Express Transcript Mode?</span>
            </div>
            <ul className="list-disc list-inside text-slate-300 space-y-1 text-[11px]">
              <li>
                Stages 1–3 (Topics, Research, Script) will be marked{' '}
                <code className="font-mono text-violet-300">EXTERNAL_PROVIDED</code>
              </li>
              <li>
                Downstream stages (Storyboard, Visual Prompts, Packaging) will be marked{' '}
                <code className="font-mono text-amber-300">DIRTY</code> for clean regeneration
              </li>
              <li>
                Project entry mode updates to <code className="font-mono text-emerald-300">EXPRESS</code> (no target duration drift or S3 rollback)
              </li>
            </ul>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowConvertExpressConfirm(false)}
                className="flex-1 min-h-[44px] py-2 rounded-xl bg-slate-800 text-slate-300 font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConvertProjectToExpress}
                className="flex-1 min-h-[44px] py-2 rounded-xl bg-violet-500 text-white font-semibold"
              >
                Confirm Express Mode
              </button>
            </div>
          </div>
        )}

        {s3Payload?.errorState?.inError && (
          <div className="liquid-glass-subtle p-4 border border-rose-500/40 bg-rose-500/10 space-y-2">
            <div className="text-xs font-semibold text-rose-300 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" />
              <span>Surgical Repair Limit Reached (Manual Edit Ready)</span>
            </div>
            <p className="text-xs text-slate-200">{s3Payload.errorState.message}</p>
            <button
              type="button"
              onClick={() => {
                const idx = s3Payload.errorState!.failingParagraphIndex;
                setActiveBox('paragraphs');
                setEditingParaIdx(idx);
                setManualParaText(s3Payload.paragraphs[idx]?.text ?? '');
              }}
              className="px-3 py-1.5 rounded-xl bg-rose-500 text-white text-xs font-semibold"
            >
              Edit Paragraph #{s3Payload.errorState.failingParagraphIndex + 1} Manually
            </button>
          </div>
        )}

        {s3Payload && (
          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between">
              <div className="flex rounded-xl bg-slate-900/90 p-1 border border-white/10">
                <button
                  type="button"
                  onClick={() => setActiveBox('box1')}
                  className={`px-3 py-1 rounded-lg text-xs font-medium ${
                    activeBox === 'box1'
                      ? 'bg-emerald-500 text-slate-950 font-semibold'
                      : 'text-slate-400'
                  }`}
                >
                  Box 1 (Display)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveBox('box2')}
                  className={`px-3 py-1 rounded-lg text-xs font-medium ${
                    activeBox === 'box2'
                      ? 'bg-violet-500 text-white font-semibold'
                      : 'text-slate-400'
                  }`}
                >
                  Box 2 (TTS Phonetic)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveBox('paragraphs')}
                  className={`px-3 py-1 rounded-lg text-xs font-medium ${
                    activeBox === 'paragraphs'
                      ? 'bg-cyan-500 text-slate-950 font-semibold'
                      : 'text-slate-400'
                  }`}
                >
                  Paragraphs ({s3Payload.paragraphs?.length ?? 0})
                </button>
              </div>

              <button
                type="button"
                onClick={() =>
                  copyText(
                    activeBox === 'box2' ? s3Payload.box2Text : s3Payload.box1Text,
                    activeBox === 'box2' ? 'Box 2 Phonetic' : 'Box 1 Script'
                  )
                }
                className="px-2.5 py-1.5 rounded-xl bg-white/10 text-xs text-slate-200 flex items-center gap-1"
              >
                <Copy className="w-3.5 h-3.5" />
                Copy
              </button>
            </div>

            {activeBox === 'box1' && (
              <pre className="font-devanagari whitespace-pre-wrap text-xs text-slate-100 bg-slate-950/80 p-4 rounded-2xl border border-white/10 max-h-72 overflow-y-auto">
                {s3Payload.box1Text}
              </pre>
            )}

            {activeBox === 'box2' && (
              <pre className="font-devanagari whitespace-pre-wrap text-xs text-emerald-100 bg-slate-950/80 p-4 rounded-2xl border border-emerald-500/20 max-h-72 overflow-y-auto">
                {s3Payload.box2Text}
              </pre>
            )}

            {activeBox === 'paragraphs' && (
              <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                {(s3Payload.paragraphs || []).map((p, idx) => (
                  <div key={p.id} className="liquid-glass-subtle p-3 space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                      <span>
                        P#{idx + 1} • {p.chapterTitle}
                      </span>
                      <div className="flex items-center gap-2">
                        <span>{p.word_count}w</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingParaIdx(idx);
                            setManualParaText(p.text);
                          }}
                          className="text-emerald-400 hover:underline flex items-center gap-0.5"
                        >
                          <Edit3 className="w-3 h-3" />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSurgicalRepair(idx)}
                          disabled={repairingScript}
                          className="text-violet-300 hover:underline flex items-center gap-0.5"
                        >
                          <Wrench className="w-3 h-3" />
                          Repair
                        </button>
                      </div>
                    </div>

                    {editingParaIdx === idx ? (
                      <div className="space-y-2">
                        <textarea
                          rows={4}
                          value={manualParaText}
                          onChange={(e) => setManualParaText(e.target.value)}
                          className="w-full p-2.5 rounded-xl bg-slate-900 border border-emerald-500/40 font-devanagari text-xs text-white"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleSaveManualParagraph(idx)}
                            className="px-3 py-1.5 rounded-xl bg-emerald-500 text-slate-950 text-xs font-semibold"
                          >
                            Save & Re-Audit
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingParaIdx(null)}
                            className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-300 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="font-devanagari text-xs text-slate-200">{p.text}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 17-Point Audit Grid */}
            {audit && (
              <div className="space-y-2 pt-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-300">
                    17-Point Verification Matrix
                  </h3>
                  {!audit.allPassed && (
                    <button
                      type="button"
                      onClick={() => handleSurgicalRepair()}
                      disabled={repairingScript}
                      className="px-3 py-1 rounded-xl bg-violet-500/20 text-violet-300 border border-violet-500/40 text-xs font-semibold flex items-center gap-1"
                    >
                      <Wrench className="w-3.5 h-3.5" />
                      {repairingScript ? 'Repairing...' : 'Surgical Repair'}
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-1.5 max-h-56 overflow-y-auto pr-1">
                  {audit.checks.map((chk) => (
                    <div
                      key={chk.code}
                      className="px-3 py-2 rounded-xl bg-slate-900/75 border border-white/8 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-white truncate">
                          <span className="font-mono text-slate-400 mr-1.5">{chk.code}</span>
                          {chk.name}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate">{chk.detail}</div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-md font-mono text-[10px] font-semibold shrink-0 ${
                          chk.status === 'PASS'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : chk.status === 'UNVERIFIED'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-rose-500/20 text-rose-300'
                        }`}
                      >
                        {chk.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* STAGE 4: GUIDED EXPRESS IMPORT STEPPER & TRANSCRIPT LOCK (U1, X1–X7) */}
      <section id="express-transcript-stepper" className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-violet-400">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">
                Express Transcript Stepper & Runtime Lock
              </h2>
              <p className="text-xs text-slate-400">
                Upload .vtt / .srt / .json / .csv / .txt or Paste Word Timestamps
              </p>
            </div>
          </div>

          {s4Payload && (
            <div className="flex items-center gap-1.5">
              {s4IsEstimated && (
                <span className="px-2 py-0.5 rounded-lg font-mono text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  ESTIMATED
                </span>
              )}
              <span
                className={`px-2.5 py-1 rounded-xl font-mono text-[11px] font-semibold border ${
                  !isExpress && s4Payload.targetDurationSec > 0 && s4Payload.drift
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                }`}
              >
                {s4Payload.actualDurationSec.toFixed(1)}s •{' '}
                {!isExpress && s4Payload.targetDurationSec > 0
                  ? `Drift ${s4Payload.driftPct.toFixed(1)}%`
                  : `${s4Payload.suggestedWpm.toFixed(1)} WPM`}
              </span>
            </div>
          )}
        </div>

        {/* X1: Persistent 5-Step Express Checklist Panel */}
        <div
          data-testid="express-checklist-panel"
          className="p-3.5 rounded-2xl bg-slate-950/90 border border-white/10 space-y-2"
        >
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-300">
            <span>Pre-Flight Checklist</span>
            <span className="font-mono text-emerald-400">
              {checklist.steps.filter((s) => s.passed).length}/{checklist.steps.length} Ready
            </span>
          </div>

          <div className="space-y-1.5">
            {checklist.steps.map((step) => (
              <div
                key={step.id}
                className={`px-3 py-2 rounded-xl border flex items-center justify-between gap-2 text-xs ${
                  step.passed
                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-200'
                    : 'bg-slate-900/90 border-white/10 text-slate-300'
                }`}
              >
                <div className="min-w-0 flex items-start gap-2">
                  <span className="font-mono text-xs shrink-0 mt-0.5" aria-hidden="true">
                    {step.passed ? '✅' : '❌'}
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold text-white truncate">
                      {step.stepNumber}. {step.title}
                    </div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {step.summaryText}
                    </div>
                  </div>
                </div>

                {step.id === 'GEMINI_KEY_AND_MODELS' && (
                  <button
                    type="button"
                    onClick={() => onNavigateHub?.('vault')}
                    className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-[11px] font-semibold shrink-0 flex items-center gap-1"
                  >
                    <KeyRound className="w-3 h-3" />
                    <span>Vault</span>
                  </button>
                )}

                {step.id === 'STYLE_LOCKED' && (
                  <button
                    type="button"
                    onClick={() => setShowQuickStyleSheet((v) => !v)}
                    className="px-2.5 py-1.5 rounded-lg bg-violet-500/20 hover:bg-violet-500/30 text-violet-200 border border-violet-500/30 text-[11px] font-semibold shrink-0 flex items-center gap-1"
                  >
                    <Dna className="w-3 h-3" />
                    <span>Quick Style</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* X3: Inline Quick Style Sheet inside the Stepper */}
        {showQuickStyleSheet && (
          <div
            data-testid="inline-quick-style-sheet"
            className="p-4 rounded-2xl bg-slate-900/95 border border-violet-500/40 space-y-3.5"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-violet-300">
                <Dna className="w-4 h-4" />
                <h3 className="text-sm font-bold text-white">
                  Inline Quick Style (Express DNA)
                </h3>
              </div>
              <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-violet-500/20 text-violet-200">
                Prefilled from transcript: {quickLanguage} ({quickScript})
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Channel Niche</label>
                <input
                  type="text"
                  aria-label="Quick Style Channel Niche"
                  value={quickNiche}
                  onChange={(e) => setQuickNiche(e.target.value)}
                  placeholder="e.g. Science explainers, Personal finance"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Format Preset</label>
                <select
                  aria-label="Quick Style Format Preset"
                  value={quickFormatPreset}
                  onChange={(e) =>
                    setQuickFormatPreset(
                      e.target.value as
                        | 'EXPLAINER'
                        | 'DOCUMENTARY'
                        | 'STORYTIME'
                        | 'LISTICLE'
                    )
                  }
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
                >
                  <option value="EXPLAINER">Explainer</option>
                  <option value="DOCUMENTARY">Documentary</option>
                  <option value="STORYTIME">Storytime</option>
                  <option value="LISTICLE">Listicle</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Language &amp; Script
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    aria-label="Quick Style Language"
                    value={quickLanguage}
                    onChange={(e) => {
                      setUserTouchedLang(true);
                      const lang = e.target.value as 'hi' | 'en' | 'es';
                      setQuickLanguage(lang);
                      setQuickScript(lang === 'hi' ? 'Devanagari' : 'Latin');
                    }}
                    className="w-full px-2.5 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
                  >
                    <option value="hi">Hindi (hi)</option>
                    <option value="en">English (en)</option>
                    <option value="es">Spanish (es)</option>
                  </select>
                  <select
                    aria-label="Quick Style Script"
                    value={quickScript}
                    onChange={(e) => {
                      setUserTouchedLang(true);
                      setQuickScript(e.target.value as 'Devanagari' | 'Latin');
                    }}
                    className="w-full px-2.5 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
                  >
                    <option value="Devanagari">Devanagari</option>
                    <option value="Latin">Latin</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Brand Name (optional)
                </label>
                <input
                  type="text"
                  aria-label="Quick Style Brand Name"
                  value={quickBrandName}
                  onChange={(e) => setQuickBrandName(e.target.value)}
                  placeholder="Optional channel brand"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] text-slate-400">
                Visual Style (Free text or tap a preset chip)
              </label>
              <input
                type="text"
                aria-label="Quick Style Visual Style"
                value={quickVisualStyle}
                onChange={(e) => setQuickVisualStyle(e.target.value)}
                placeholder="Describe visual style or pick a chip below..."
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {QUICK_STYLE_VISUAL_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setQuickVisualStyle(preset)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] border transition-all ${
                      quickVisualStyle === preset
                        ? 'bg-violet-500/25 border-violet-400 text-violet-200 font-semibold'
                        : 'bg-slate-950 border-white/10 text-slate-300 hover:border-white/25'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Style Prefix (optional)
                </label>
                <input
                  type="text"
                  value={quickStylePrefix}
                  onChange={(e) => setQuickStylePrefix(e.target.value)}
                  placeholder="Prepended to every visual prompt"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Negative Prompts (comma separated)
                </label>
                <input
                  type="text"
                  value={quickNegativePrompts}
                  onChange={(e) => setQuickNegativePrompts(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowQuickStyleSheet(false)}
                className="flex-1 min-h-[44px] py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleQuickStyleLock}
                disabled={lockingQuickStyle}
                className="flex-1 min-h-[44px] py-2 rounded-xl bg-violet-500 hover:bg-violet-400 text-white text-xs font-semibold active:scale-[0.97]"
              >
                {lockingQuickStyle ? 'Locking Style...' : 'Lock Quick Style'}
              </button>
            </div>
          </div>
        )}

        {/* X1 Step 4: Inline Generation Mode + Engine + Duration Selector */}
        <div className="p-3.5 rounded-2xl bg-slate-900/75 border border-white/10 space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-white">
              Step 4: Pacing Mode, Engine &amp; Clip Duration
            </span>
            {pacingRuleBounds && (
              <span className="font-mono text-[11px] text-emerald-400">
                Slot bounds: {pacingRuleBounds.minSec.toFixed(1)}s–{pacingRuleBounds.maxSec.toFixed(1)}s
                {savingPacing ? ' (saving...)' : ''}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Generation Mode</label>
              <select
                aria-label="Express Generation Mode"
                value={generationMode}
                onChange={(e) =>
                  void handleSaveInlinePacing(
                    e.target.value as GenerationMode,
                    videoProvider,
                    clipDuration
                  )
                }
                className="w-full px-2.5 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
              >
                <option value="MODE_1_IMAGE">Mode 1 (Keyframe 1.0–2.8s)</option>
                <option value="MODE_2_VIDEO">Mode 2 (Image → Video)</option>
                <option value="MODE_3_DIRECT_VIDEO">Mode 3 (Direct Video)</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Video Engine</label>
              <select
                aria-label="Express Video Engine"
                value={videoProvider}
                onChange={(e) => {
                  const nextProv = e.target.value as VideoProvider;
                  const nextDur =
                    nextProv === 'VEO_3_1' ? VEO_3_1_FIXED_DURATION : clipDuration;
                  void handleSaveInlinePacing(generationMode, nextProv, nextDur);
                }}
                className="w-full px-2.5 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white"
              >
                <option value="VEO_3_1">Veo 3.1 (Fixed 8s)</option>
                <option value="OMNI_FLASH">Omni Flash (4/6/8/10s)</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Clip Duration</label>
              <select
                aria-label="Express Clip Duration"
                value={
                  videoProvider === 'VEO_3_1' ? VEO_3_1_FIXED_DURATION : clipDuration
                }
                disabled={videoProvider === 'VEO_3_1'}
                onChange={(e) =>
                  void handleSaveInlinePacing(
                    generationMode,
                    videoProvider,
                    Number(e.target.value)
                  )
                }
                className="w-full px-2.5 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white disabled:opacity-60 font-mono"
              >
                {videoProvider === 'VEO_3_1' ? (
                  <option value={8}>8s (Veo 3.1 Locked)</option>
                ) : (
                  OMNI_FLASH_DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}s
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>
        </div>

        {/* U1: Upload Transcript File Card (Android-safe accept + Drag & Drop + Clear) */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            const droppedFile = e.dataTransfer.files?.[0];
            if (droppedFile) {
              void handleTranscriptFileSelected(droppedFile);
            }
          }}
          className={`p-4 rounded-2xl border-2 border-dashed transition-all space-y-3 ${
            dragActive
              ? 'border-emerald-400 bg-emerald-500/10'
              : 'border-white/15 bg-slate-900/70'
          }`}
        >
          <input
            ref={transcriptFileInputRef}
            type="file"
            accept={ANDROID_SAFE_TRANSCRIPT_ACCEPT}
            multiple={false}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void handleTranscriptFileSelected(file);
              }
            }}
            className="hidden"
            aria-label="Upload transcript file input"
          />

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <button
              type="button"
              onClick={() => transcriptFileInputRef.current?.click()}
              className="min-h-[48px] px-4 py-3 rounded-2xl bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/40 text-violet-200 font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.98]"
            >
              <Upload className="w-4 h-4 text-violet-300 shrink-0" />
              <span>Upload transcript file (.vtt, .srt, .json, .csv, .tsv, .txt)</span>
            </button>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <label
                  htmlFor="transcript-units-override"
                  className="text-[11px] text-slate-400"
                >
                  Units:
                </label>
                <select
                  id="transcript-units-override"
                  aria-label="Transcript Units Override"
                  value={uploadState.unitsOverride ?? ''}
                  onChange={(e) =>
                    void handleUnitsOverrideChange(
                      e.target.value as DetectedTimeUnit | ''
                    )
                  }
                  className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-slate-950 border border-white/10 text-xs text-white font-mono"
                >
                  <option value="">AUTO</option>
                  <option value="SECONDS">SECONDS</option>
                  <option value="MILLISECONDS">MILLISECONDS</option>
                  <option value="TIMECODE">TIMECODE</option>
                </select>
              </div>

              {(transcriptInput || uploadState.fileName) && (
                <button
                  type="button"
                  onClick={handleClearTranscript}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 text-xs font-semibold flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear</span>
                </button>
              )}
            </div>
          </div>

          {/* File Metadata & Detected Format Chips */}
          {(uploadState.fileName || parsedPreview) && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
              {uploadState.fileName && (
                <span className="px-2 py-0.5 rounded-md bg-violet-500/20 text-violet-200 border border-violet-500/30">
                  File: {uploadState.fileName} ({((uploadState.fileSizeBytes ?? 0) / 1024).toFixed(1)} KB)
                </span>
              )}
              {uploadState.detectedEncoding && (
                <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-300">
                  Encoding: {uploadState.detectedEncoding}
                </span>
              )}
              {parsedPreview && (
                <>
                  <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    Format: {parsedPreview.meta.format}
                  </span>
                  <span className="px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-300 border border-sky-500/30">
                    Units: {parsedPreview.meta.units}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Editable Paste Box */}
          <textarea
            rows={4}
            aria-label="Transcript text or paste box"
            value={transcriptInput}
            onChange={(e) => {
              setTranscriptInput(e.target.value);
              setInlineFixCard(null);
            }}
            placeholder="Paste or upload real transcript: WebVTT, SRT, WhisperX JSON, Descript JSON, ElevenLabs JSON, CSV/TSV, or tagged lines #[00-01.500] word..."
            className="w-full px-3.5 py-2.5 rounded-2xl bg-slate-950/90 border border-white/10 text-xs text-white font-mono"
          />

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
            <input
              type="number"
              aria-label="Audio Duration Seconds Override"
              value={actualSecInput}
              onChange={(e) => setActualSecInput(e.target.value)}
              placeholder="Optional audio container duration (sec)"
              className="sm:w-64 px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white font-mono"
            />
            <button
              type="button"
              onClick={() => void runPreviewRequest(transcriptInput)}
              disabled={previewing || !transcriptInput.trim()}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 font-semibold text-xs flex items-center justify-center gap-1.5"
            >
              <Eye className="w-4 h-4 text-sky-400" />
              <span>{previewing ? 'Parsing...' : 'Preview Parse & Quality'}</span>
            </button>
          </div>
        </div>

        {/* X2: Inline Gate / Validation Error Fix Card */}
        {inlineFixCard && (
          <div
            role="alert"
            data-testid="inline-gate-fix-card"
            className="p-4 rounded-2xl bg-rose-950/80 border border-rose-500/50 space-y-2.5 text-xs"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-rose-300 font-bold">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{inlineFixCard.title}</span>
              </div>
              <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-rose-500/20 text-rose-200">
                {inlineFixCard.code}
              </span>
            </div>
            <p className="text-slate-200 leading-relaxed">{inlineFixCard.description}</p>

            {inlineFixCard.actionType === 'SELECT_TIME_UNITS' ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[11px] text-rose-200 font-semibold">
                  Choose timestamp units:
                </span>
                {(['SECONDS', 'MILLISECONDS', 'TIMECODE'] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => void handleUnitsOverrideChange(u)}
                    className="min-h-[38px] px-3 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-mono text-xs font-semibold"
                  >
                    Use {u}
                  </button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleInlineFixAction(inlineFixCard)}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-semibold text-xs flex items-center gap-1.5"
              >
                <span>{inlineFixCard.actionButtonLabel}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Parsed Preview Summary + Word Table */}
        {parsedPreview && (
          <div className="p-3.5 rounded-2xl bg-slate-900/80 border border-white/10 space-y-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`px-2.5 py-0.5 rounded-md font-mono text-[11px] font-bold ${
                  parsedPreview.meta.precisionGrade === 'WORD_EXACT_MS'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : parsedPreview.meta.precisionGrade === 'WORD_COARSE'
                      ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                }`}
              >
                {parsedPreview.meta.precisionGrade}
                {parsedPreview.meta.hasEstimatedWords ? ' (Interpolated cues)' : ' (Word-level)'}
              </span>
              <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 font-mono text-[10px]">
                {parsedPreview.meta.format} • {parsedPreview.meta.units}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                <div className="text-[10px] text-slate-400">Locked Runtime</div>
                <div className="font-mono text-emerald-400 font-bold">
                  {parsedPreview.meta.metrology.lockedRuntimeSec.toFixed(2)}s
                </div>
              </div>
              <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                <div className="text-[10px] text-slate-400">Word Count</div>
                <div className="font-mono text-white font-bold">
                  {parsedPreview.meta.metrology.wordCount}
                </div>
              </div>
              <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                <div className="text-[10px] text-slate-400">Actual WPM</div>
                <div className="font-mono text-sky-400 font-bold">
                  {parsedPreview.meta.metrology.actualWpm.toFixed(1)}
                </div>
              </div>
              <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                <div className="text-[10px] text-slate-400">Silence Gaps &gt;2s</div>
                <div className="font-mono text-amber-400 font-bold">
                  {parsedPreview.meta.metrology.silenceCount}
                </div>
              </div>
            </div>

            {parsedPreview.meta.warnings.length > 0 && (
              <div className="space-y-1 text-[11px] text-amber-300 bg-amber-500/10 p-2.5 rounded-xl border border-amber-500/20">
                {parsedPreview.meta.warnings.map((w, i) => (
                  <div key={i}>• {w}</div>
                ))}
              </div>
            )}

            {/* X5: Explicit Consent Checkbox for CUE_INTERPOLATED */}
            {parsedPreview.meta.precisionGrade === 'CUE_INTERPOLATED' && (
              <label
                data-testid="confirm-estimated-label"
                className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-500/15 border border-amber-500/40 cursor-pointer text-xs text-amber-100"
              >
                <input
                  type="checkbox"
                  checked={confirmEstimated}
                  onChange={(e) => {
                    setConfirmEstimated(e.target.checked);
                    if (
                      e.target.checked &&
                      inlineFixCard?.code === 'ESTIMATED_TIMINGS_UNCONFIRMED'
                    ) {
                      setInlineFixCard(null);
                    }
                  }}
                  className="mt-0.5 w-4 h-4 accent-amber-400 shrink-0"
                />
                <span>
                  I understand word times are estimated from cue boundaries (±
                  {parsedPreview.meta.worstCaseCueErrorMs ?? 500} ms)
                </span>
              </label>
            )}

            {/* Word Preview Table (highlights offending word index if any) */}
            <div
              ref={previewTableRef}
              className="max-h-36 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/80 p-2"
            >
              <div className="grid grid-cols-3 text-[10px] font-mono text-slate-400 pb-1 border-b border-white/10">
                <span># Word</span>
                <span>Start (s)</span>
                <span>End (s)</span>
              </div>
              <div className="divide-y divide-white/5">
                {parsedPreview.words.slice(0, 60).map((w, idx) => {
                  const isHighlighted = highlightedWordIdx === idx;
                  return (
                    <div
                      key={idx}
                      className={`grid grid-cols-3 py-1 px-1 text-[11px] font-mono ${
                        isHighlighted
                          ? 'bg-rose-500/30 text-rose-200 font-bold'
                          : 'text-slate-300'
                      }`}
                    >
                      <span className="truncate font-devanagari">
                        #{idx} {w.word}
                      </span>
                      <span>{w.startSec.toFixed(3)}</span>
                      <span>
                        {w.endSec.toFixed(3)}
                        {w.estimated ? ' ~' : ''}
                        {w.lastWordEndInferred ? ' *' : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* U1: Optional Second Upload Slot — Original Script (.txt/.md) */}
        <div className="p-3.5 rounded-2xl bg-slate-900/60 border border-white/10 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] font-medium text-slate-300">
              Original script (optional, .txt/.md for fuzzy paragraph alignment)
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={scriptFileInputRef}
                type="file"
                accept={ANDROID_SAFE_SCRIPT_ACCEPT}
                multiple={false}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleScriptFileSelected(f);
                }}
                className="hidden"
                aria-label="Upload optional script file"
              />
              <button
                type="button"
                onClick={() => scriptFileInputRef.current?.click()}
                className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-[11px] text-slate-200 flex items-center gap-1"
              >
                <FileUp className="w-3.5 h-3.5" />
                <span>{scriptFileName ? scriptFileName : 'Upload .txt/.md'}</span>
              </button>
            </div>
          </div>
          <textarea
            rows={2}
            value={optionalScriptText}
            onChange={(e) => setOptionalScriptText(e.target.value)}
            placeholder="Paste or upload original spoken script text..."
            className="w-full px-3 py-2 rounded-xl bg-slate-950/70 border border-white/10 text-xs text-white"
          />
        </div>

        {/* X1 & X7: Primary Checklist Action Button + Visible Reason Line + Lock & Slice in One Tap */}
        <div className="space-y-2 pt-1">
          {checklist.disabledReason && (
            <div
              data-testid="primary-button-reason"
              className="text-xs font-medium text-amber-300 bg-amber-500/10 border border-amber-500/25 px-3 py-2 rounded-xl flex items-center gap-2"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>{checklist.disabledReason}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              data-testid="express-primary-action-btn"
              onClick={handlePrimaryChecklistClick}
              disabled={lockingTranscript || lockingAndSlicing}
              className={`w-full min-h-[48px] py-3 rounded-2xl font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.98] ${
                checklist.canLock
                  ? 'bg-violet-500 hover:bg-violet-400 text-white shadow-lg shadow-violet-500/20'
                  : 'bg-amber-500 hover:bg-amber-400 text-slate-950'
              }`}
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>
                {lockingTranscript ? 'Locking Transcript...' : checklist.primaryButtonLabel}
              </span>
            </button>

            <button
              type="button"
              data-testid="lock-and-slice-btn"
              onClick={handleLockAndSliceInOneTap}
              disabled={!checklist.canLock || lockingTranscript || lockingAndSlicing}
              className="w-full min-h-[48px] py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 active:scale-[0.98]"
            >
              <Zap className="w-4 h-4" />
              <span>
                {lockingAndSlicing ? 'Locking & Slicing...' : 'Lock & slice in one tap'}
              </span>
            </button>
          </div>
        </div>

        {/* X7: Post-Lock Success Card with "Slice storyboard now" */}
        {s4Payload && (
          <div
            data-testid="transcript-locked-success-card"
            className="p-4 rounded-2xl bg-emerald-950/60 border border-emerald-500/40 space-y-3"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 text-emerald-300 font-bold text-xs">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>Transcript Locked — Ready for Storyboard</span>
              </div>
              <div className="flex items-center gap-1.5">
                {s4IsEstimated && (
                  <span className="px-2 py-0.5 rounded-md font-mono text-[10px] font-bold bg-amber-500/25 text-amber-200 border border-amber-500/40">
                    ESTIMATED
                  </span>
                )}
                <span className="px-2 py-0.5 rounded-md font-mono text-[10px] bg-emerald-500/20 text-emerald-300">
                  {s4Payload.meta?.precisionGrade ?? 'WORD_EXACT_MS'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="p-2 rounded-xl bg-slate-950/70 border border-white/10">
                <div className="text-[10px] text-slate-400">Runtime (Last Word)</div>
                <div className="font-mono font-bold text-white">
                  {s4Payload.actualDurationSec.toFixed(2)}s
                </div>
              </div>
              <div className="p-2 rounded-xl bg-slate-950/70 border border-white/10">
                <div className="text-[10px] text-slate-400">Words</div>
                <div className="font-mono font-bold text-white">
                  {s4Payload.words.length}
                </div>
              </div>
              <div className="p-2 rounded-xl bg-slate-950/70 border border-white/10">
                <div className="text-[10px] text-slate-400">Actual WPM</div>
                <div className="font-mono font-bold text-emerald-400">
                  {s4Payload.suggestedWpm.toFixed(1)}
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                data-testid="slice-storyboard-now-btn"
                onClick={handleSliceStoryboard}
                disabled={slicingStoryboard}
                className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5"
              >
                <Film className="w-4 h-4" />
                <span>
                  {slicingStoryboard ? 'Slicing Storyboard...' : 'Slice storyboard now'}
                </span>
              </button>

              {s5Payload && s5Payload.slotCount > 0 && (
                <button
                  type="button"
                  data-testid="continue-to-prompts-btn"
                  onClick={() => onNavigateHub?.('export')}
                  className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-violet-500 hover:bg-violet-400 text-white font-bold text-xs flex items-center justify-center gap-1.5"
                >
                  <span>
                    Prompts &amp; Export ({s5Payload.slotCount} slots)
                  </span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Drift & S3 Rollback ONLY shown for FULL-mode projects with targetDurationSec > 0 */}
        {!isExpress && s4Payload && s4Payload.targetDurationSec > 0 && s4Payload.drift && (
          <div className="liquid-glass-subtle p-4 border border-amber-500/40 bg-amber-500/10 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                Runtime Drift Exceeds 5% ({s4Payload.driftPct.toFixed(2)}%)
              </span>
              <span className="font-mono text-xs text-amber-200">
                Actual: {s4Payload.suggestedWpm.toFixed(2)} WPM
              </span>
            </div>
            <p className="text-xs text-slate-200">
              One-click rollback updates project speaking pace to{' '}
              {s4Payload.suggestedWpm.toFixed(2)} WPM and marks downstream stages for clean
              regeneration.
            </p>
            <button
              type="button"
              onClick={handleOneClickRollback}
              disabled={rollingBack}
              className="w-full min-h-[44px] py-2.5 rounded-xl bg-amber-500 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 active:scale-[0.97]"
            >
              <RotateCcw className="w-4 h-4" />
              {rollingBack ? 'Rolling Back...' : 'One-Click Rollback & Recalibrate WPM'}
            </button>
          </div>
        )}
      </section>

      {/* STAGE 5: STORYBOARD SLICER */}
      <section ref={storyboardSectionRef} className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Film className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Storyboard Slicer</h2>
              <p className="text-xs text-slate-400">Model-Locked Pacing Table &amp; 70/30 Split</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {s4IsEstimated && (
              <span className="px-2 py-0.5 rounded-md font-mono text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                ESTIMATED
              </span>
            )}
            {s5Payload && (
              <span className="font-mono text-xs text-emerald-400">
                {s5Payload.slotCount} Slots
              </span>
            )}
          </div>
        </div>

        {!s4Payload && (
          <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 px-3 py-2 rounded-xl">
            Lock a transcript in Step 4 above before slicing the storyboard.
          </div>
        )}

        <button
          type="button"
          onClick={handleSliceStoryboard}
          disabled={slicingStoryboard || !s4Payload}
          className="w-full min-h-[44px] py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
        >
          <Film className="w-4 h-4" />
          {slicingStoryboard ? 'Slicing Storyboard...' : 'Slice Model-Locked Storyboard'}
        </button>

        {s5Payload && s5Payload.slots.length > 0 && (
          <div className="space-y-2.5">
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {s5Payload.slots.slice(0, 15).map((slot) => (
                <div
                  key={slot.slotIndex}
                  className="px-3 py-2 rounded-xl bg-slate-900/80 border border-white/8 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] text-emerald-400">
                      Slot #{slot.slotIndex} • {slot.startSec.toFixed(2)}s–
                      {slot.endSec.toFixed(2)}s ({slot.durationSec.toFixed(2)}s)
                    </div>
                    <div className="font-devanagari text-xs text-slate-200 truncate">
                      {slot.spokenSegment}
                    </div>
                  </div>
                  <span className="font-mono text-[10px] text-violet-300 shrink-0">
                    Act {slot.actionSec.toFixed(2)}s / Hold {slot.holdSec.toFixed(2)}s
                  </span>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => onNavigateHub?.('export')}
              className="w-full min-h-[44px] py-3 rounded-2xl bg-violet-500 hover:bg-violet-400 text-white font-semibold text-xs flex items-center justify-center gap-1.5"
            >
              <span>Open Prompts &amp; Packaging Hub ({s5Payload.slotCount} slots)</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </section>
    </div>
  );
};
