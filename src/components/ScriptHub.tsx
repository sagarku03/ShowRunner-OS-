import React, { useState } from 'react';
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
  Wand2,
  Dna,
} from 'lucide-react';
import type {
  PipelineStateVector,
  ProjectItem,
  S3StagePayload,
  S4StagePayload,
  S5StagePayload,
} from '../types/showrunner.ts';
import { apiRequest } from '../utils/apiClient.ts';

interface ScriptHubProps {
  activeProject: ProjectItem | null;
  stateVector: PipelineStateVector | null;
  onRefreshState: () => Promise<void>;
  onNotify: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const ScriptHub: React.FC<ScriptHubProps> = ({
  activeProject,
  stateVector,
  onRefreshState,
  onNotify,
}) => {
  const s3Payload = (stateVector?.context?.S3?.payload as S3StagePayload | null) ?? null;
  const s4Payload = (stateVector?.context?.S4?.payload as S4StagePayload | null) ?? null;
  const s5Payload = (stateVector?.context?.S5?.payload as S5StagePayload | null) ?? null;

  const [activeBox, setActiveBox] = useState<'box1' | 'box2' | 'paragraphs'>('box1');
  const [generatingScript, setGeneratingScript] = useState(false);
  const [repairingScript, setRepairingScript] = useState(false);

  const [editingParaIdx, setEditingParaIdx] = useState<number | null>(null);
  const [manualParaText, setManualParaText] = useState('');

  const [transcriptInput, setTranscriptInput] = useState('');
  const [actualSecInput, setActualSecInput] = useState<string>('');
  const [lockingTranscript, setLockingTranscript] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [slicingStoryboard, setSlicingStoryboard] = useState(false);

  const isExpress =
    activeProject?.entryMode === 'EXPRESS' ||
    stateVector?.context?.S3?.status === 'EXTERNAL_PROVIDED';

  const [previewing, setPreviewing] = useState(false);
  const [parsedPreview, setParsedPreview] = useState<{
    words: Array<{ word: string; startSec: number; endSec: number; estimated?: boolean }>;
    meta: {
      format: string;
      units: string;
      precisionGrade: string;
      hasEstimatedWords: boolean;
      cleanedTokens: Array<{ token: string; count: number }>;
      warnings: string[];
      metrology: {
        wordCount: number;
        lockedRuntimeSec: number;
        actualWpm: number;
        silenceCount: number;
        longestSilenceMs: number;
      };
    };
  } | null>(null);
  const [optionalScriptText, setOptionalScriptText] = useState('');
  const [showQuickStyleSheet, setShowQuickStyleSheet] = useState(false);
  const [quickNiche, setQuickNiche] = useState(activeProject?.niche || 'General Creator Channel');
  const [quickVisualStyle, setQuickVisualStyle] = useState('Cinematic 8k');
  const [quickStylePrefix, setQuickStylePrefix] = useState('');
  const [quickNegativePrompts, setQuickNegativePrompts] = useState('blurry, cartoon, watermark');
  const [lockingQuickStyle, setLockingQuickStyle] = useState(false);

  const handlePreviewTranscript = async () => {
    if (!transcriptInput.trim()) {
      onNotify('Please paste transcript content to preview', 'warn');
      return;
    }
    setPreviewing(true);
    try {
      const res = await apiRequest<typeof parsedPreview>('/api/v1/stage/4/transcript/preview', {
        method: 'POST',
        body: {
          transcript: transcriptInput.trim(),
          scriptText: optionalScriptText.trim() || undefined,
        },
      });
      setParsedPreview(res);
      if (res) {
        onNotify(
          `Parsed ${res.words.length} words (${res.meta.precisionGrade}) • Runtime ${res.meta.metrology.lockedRuntimeSec.toFixed(1)}s`,
          'success'
        );
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setPreviewing(false);
    }
  };

  const handleQuickStyleLock = async () => {
    setLockingQuickStyle(true);
    try {
      await apiRequest('/api/v1/stage/0/quick-style', {
        method: 'POST',
        body: {
          niche: quickNiche,
          visualStyle: quickVisualStyle,
          stylePrefix: quickStylePrefix,
          negativePrompts: quickNegativePrompts.split(',').map((s) => s.trim()).filter(Boolean),
        },
      });
      await onRefreshState();
      setShowQuickStyleSheet(false);
      onNotify('Quick Style Channel DNA locked', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
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
      onNotify((err as Error).message, 'error');
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
      onNotify((err as Error).message, 'error');
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
      onNotify((err as Error).message, 'error');
    } finally {
      setRepairingScript(false);
    }
  };

  const handleLockTranscriptSubmit = async () => {
    setLockingTranscript(true);
    try {
      const sec = actualSecInput ? Number(actualSecInput) : undefined;
      await apiRequest('/api/v1/stage/4/transcript', {
        method: 'POST',
        body: {
          transcript: transcriptInput.trim() || undefined,
          actualDurationSec: sec && sec > 0 ? sec : undefined,
          scriptText: optionalScriptText.trim() || undefined,
          entryMode: isExpress ? 'EXPRESS' : undefined,
        },
      });
      await onRefreshState();
      onNotify('Transcript locked to final word timestamp', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLockingTranscript(false);
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
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSlicingStoryboard(false);
    }
  };

  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    onNotify(`${label} copied`, 'success');
  };

  const audit = s3Payload?.auditReport;

  return (
    <div className="space-y-5 pb-28">
      {/* STAGE 3: DUAL SCRIPT & 17-POINT AUDIT */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Dual Script Engine</h2>
              <p className="text-xs text-slate-400">
                {isExpress ? 'Express Mode: S1–S3 Bypassed' : 'Box 1 Display + Box 2 Pure Devanagari'}
              </p>
            </div>
          </div>

          {isExpress ? (
            <span className="px-2.5 py-1 rounded-xl font-mono text-[11px] font-semibold bg-violet-500/20 text-violet-300 border border-violet-500/30">
              EXPRESS BYPASS
            </span>
          ) : audit && (
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
          )}
        </div>

        {isExpress ? (
          <div className="p-3.5 rounded-2xl bg-violet-500/10 border border-violet-500/20 text-xs text-slate-300 space-y-2">
            <p>
              This project is running in <strong className="text-white">Express Transcript Mode</strong>. Stages 1–3 are marked as external/bypassed. Paste your real word-level timestamp transcript below to calibrate runtime and slice your model-locked storyboard.
            </p>
            <button
              type="button"
              onClick={() => setShowQuickStyleSheet(true)}
              className="px-3 py-1.5 rounded-xl bg-violet-500/20 text-violet-300 border border-violet-500/30 text-xs font-semibold flex items-center gap-1.5"
            >
              <Dna className="w-3.5 h-3.5" />
              Configure Quick Style DNA
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleGenerateScript}
            disabled={generatingScript || !activeProject}
            className="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
          >
            <Sparkles className="w-4 h-4" />
            {generatingScript ? 'Synthesizing & Auditing Script...' : 'Generate Dual Script & Run 17-Point Audit'}
          </button>
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
                {s3Payload.paragraphs.map((p, idx) => (
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

      {/* STAGE 4: TRANSCRIPT LOCK & 5% DRIFT ROLLBACK */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-violet-400">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Transcript Lock & Drift</h2>
              <p className="text-xs text-slate-400">Word Timestamp Sync & 5% Drift Guard</p>
            </div>
          </div>

          {s4Payload && (
            <span
              className={`px-2.5 py-1 rounded-xl font-mono text-[11px] font-semibold border ${
                s4Payload.drift
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              }`}
            >
              {s4Payload.actualDurationSec.toFixed(1)}s • Drift {s4Payload.driftPct.toFixed(1)}%
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <input
            type="number"
            value={actualSecInput}
            onChange={(e) => setActualSecInput(e.target.value)}
            placeholder="Audio Secs (optional)"
            className="w-full px-3.5 py-2.5 rounded-2xl bg-slate-900/80 border border-white/10 text-xs text-white font-mono"
          />
          <button
            type="button"
            onClick={handlePreviewTranscript}
            disabled={previewing || !transcriptInput.trim()}
            className="w-full py-2.5 rounded-2xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-semibold text-xs flex items-center justify-center gap-1.5 active:scale-[0.97]"
          >
            <Eye className="w-4 h-4 text-sky-400" />
            {previewing ? 'Parsing...' : 'Preview Parse & Quality'}
          </button>
          <button
            type="button"
            onClick={handleLockTranscriptSubmit}
            disabled={lockingTranscript || (!isExpress && !s3Payload)}
            className="w-full py-2.5 rounded-2xl bg-violet-500 hover:bg-violet-400 disabled:opacity-40 text-white font-semibold text-xs flex items-center justify-center gap-1.5 active:scale-[0.97]"
          >
            <CheckCircle2 className="w-4 h-4" />
            {lockingTranscript ? 'Locking...' : 'Lock Transcript Runtime'}
          </button>
        </div>

        <textarea
          rows={4}
          value={transcriptInput}
          onChange={(e) => setTranscriptInput(e.target.value)}
          placeholder="Paste real transcript: WebVTT, SRT, WhisperX JSON, Descript JSON, ElevenLabs JSON, CSV/TSV, or tagged lines #[00-01.500] word..."
          className="w-full px-3.5 py-2 rounded-2xl bg-slate-900/70 border border-white/10 text-xs text-white font-mono"
        />

        {parsedPreview && (
          <div className="p-3.5 rounded-2xl bg-slate-900/80 border border-white/10 space-y-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`px-2.5 py-0.5 rounded-md font-mono text-[11px] font-bold ${
                parsedPreview.meta.precisionGrade === 'WORD_EXACT_MS'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : parsedPreview.meta.precisionGrade === 'WORD_COARSE'
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              }`}>
                {parsedPreview.meta.precisionGrade}
                {parsedPreview.meta.hasEstimatedWords ? ' (Interpolated words)' : ' (Exact)'}
              </span>
              <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 font-mono text-[10px]">
                {parsedPreview.meta.format} • {parsedPreview.meta.units}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                <div className="text-[10px] text-slate-400">Locked Runtime</div>
                <div className="font-mono text-emerald-400 font-bold">
                  {parsedPreview.meta.metrology.lockedRuntimeSec.toFixed(1)}s
                </div>
              </div>
              <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                <div className="text-[10px] text-slate-400">Word Count</div>
                <div className="font-mono text-white font-bold">{parsedPreview.meta.metrology.wordCount}</div>
              </div>
              <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                <div className="text-[10px] text-slate-400">Actual WPM</div>
                <div className="font-mono text-sky-400 font-bold">{parsedPreview.meta.metrology.actualWpm.toFixed(1)}</div>
              </div>
              <div className="p-2 rounded-xl bg-slate-950/60 border border-white/5">
                <div className="text-[10px] text-slate-400">Silence Gaps &gt;2s</div>
                <div className="font-mono text-amber-400 font-bold">{parsedPreview.meta.metrology.silenceCount}</div>
              </div>
            </div>

            {parsedPreview.meta.cleanedTokens.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[10px] text-slate-400">Non-speech tokens stripped:</span>
                {parsedPreview.meta.cleanedTokens.map((t) => (
                  <span key={t.token} className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-mono">
                    {t.token} ({t.count})
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="space-y-1">
          <label className="block text-[11px] text-slate-400">
            Optional Original Script (for fuzzy paragraph alignment)
          </label>
          <textarea
            rows={2}
            value={optionalScriptText}
            onChange={(e) => setOptionalScriptText(e.target.value)}
            placeholder="Paste your original spoken script text here if you want transcript words mapped to script paragraphs..."
            className="w-full px-3.5 py-2 rounded-xl bg-slate-900/60 border border-white/10 text-xs text-white"
          />
        </div>

        {s4Payload?.drift && (
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
              One-click rollback updates project speaking pace to {s4Payload.suggestedWpm.toFixed(2)}{' '}
              WPM and marks downstream stages for clean regeneration.
            </p>
            <button
              type="button"
              onClick={handleOneClickRollback}
              disabled={rollingBack}
              className="w-full py-2.5 rounded-xl bg-amber-500 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 active:scale-[0.97]"
            >
              <RotateCcw className="w-4 h-4" />
              {rollingBack ? 'Rolling Back...' : 'One-Click Rollback & Recalibrate WPM'}
            </button>
          </div>
        )}
      </section>

      {/* STAGE 5: STORYBOARD SLICER */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Film className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Storyboard Slicer</h2>
              <p className="text-xs text-slate-400">Model-Locked Pacing Table & 70/30 Split</p>
            </div>
          </div>

          {s5Payload && (
            <span className="font-mono text-xs text-emerald-400">
              {s5Payload.slotCount} Slots
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handleSliceStoryboard}
          disabled={slicingStoryboard || !s4Payload}
          className="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
        >
          <Film className="w-4 h-4" />
          {slicingStoryboard ? 'Slicing Storyboard...' : 'Slice Model-Locked Storyboard'}
        </button>

        {s5Payload && s5Payload.slots.length > 0 && (
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {s5Payload.slots.slice(0, 15).map((slot) => (
              <div
                key={slot.slotIndex}
                className="px-3 py-2 rounded-xl bg-slate-900/80 border border-white/8 flex items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-mono text-[11px] text-emerald-400">
                    Slot #{slot.slotIndex} • {slot.startSec.toFixed(2)}s–{slot.endSec.toFixed(2)}s (
                    {slot.durationSec.toFixed(2)}s)
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
        )}
      </section>

      {showQuickStyleSheet && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="liquid-glass w-full max-w-sm p-5 space-y-4">
            <div className="flex items-center gap-2 text-violet-400">
              <Dna className="w-5 h-5" />
              <h2 className="text-base font-bold text-white">Quick Style Channel DNA</h2>
            </div>
            <p className="text-xs text-slate-300">
              Configure minimal visual & brand direction for Express mode. Locks Channel DNA with source: EXPRESS.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Channel Niche</label>
                <input
                  type="text"
                  value={quickNiche}
                  onChange={(e) => setQuickNiche(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Visual Aesthetic</label>
                <input
                  type="text"
                  value={quickVisualStyle}
                  onChange={(e) => setQuickVisualStyle(e.target.value)}
                  placeholder="e.g. Cinematic 8k, dark moody atmosphere"
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Style Prefix (prepended to every prompt line)</label>
                <input
                  type="text"
                  value={quickStylePrefix}
                  onChange={(e) => setQuickStylePrefix(e.target.value)}
                  placeholder="e.g. Cinematic film still, photorealistic"
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Negative Prompts (comma separated)</label>
                <input
                  type="text"
                  value={quickNegativePrompts}
                  onChange={(e) => setQuickNegativePrompts(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowQuickStyleSheet(false)}
                className="flex-1 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleQuickStyleLock}
                disabled={lockingQuickStyle}
                className="flex-1 py-2 rounded-xl bg-violet-500 text-white text-xs font-semibold active:scale-[0.97]"
              >
                {lockingQuickStyle ? 'Locking...' : 'Lock DNA'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
