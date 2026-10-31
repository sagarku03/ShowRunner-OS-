import React, { useState } from 'react';
import {
  PackageCheck,
  Sparkles,
  Copy,
  Send,
  CheckCircle2,
  Download,
  Layers,
  Tag,
} from 'lucide-react';
import type {
  PipelineStateVector,
  ProjectItem,
  S6StagePayload,
  S7StagePayload,
} from '../types/showrunner.ts';
import { apiRequest, downloadBundleZip } from '../utils/apiClient.ts';

interface ExportHubProps {
  activeProject: ProjectItem | null;
  stateVector: PipelineStateVector | null;
  wsConnected: boolean;
  onRefreshState: () => Promise<void>;
  onNotify: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const ExportHub: React.FC<ExportHubProps> = ({
  activeProject,
  stateVector,
  wsConnected,
  onRefreshState,
  onNotify,
}) => {
  const s4Payload = (stateVector?.context?.S4?.payload as {
    meta?: { precisionGrade?: string; hasEstimatedWords?: boolean };
  } | null) ?? null;
  const rawS5 = (stateVector?.context?.S5?.payload as { slots?: unknown[] } | null) ?? null;
  const s5Payload = rawS5 && Array.isArray(rawS5.slots) ? rawS5 : null;
  const rawS6 = (stateVector?.context?.S6?.payload as S6StagePayload | null) ?? null;
  const s6Payload =
    rawS6 && (Array.isArray(rawS6.batches) || Array.isArray(rawS6.packs)) ? rawS6 : null;
  const rawS7 = (stateVector?.context?.S7?.payload as S7StagePayload | null) ?? null;
  const s7Payload =
    rawS7 && Array.isArray(rawS7.variants) && rawS7.emri ? rawS7 : null;

  const isEstimatedTiming =
    s4Payload?.meta?.precisionGrade === 'CUE_INTERPOLATED' ||
    Boolean(s4Payload?.meta?.hasEstimatedWords);

  const [generatingPrompts, setGeneratingPrompts] = useState(false);
  const [pushingPack, setPushingPack] = useState<number | null>(null);
  const [generatingPackaging, setGeneratingPackaging] = useState(false);
  const [selectingPack, setSelectingPack] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);

  const handleGeneratePrompts = async () => {
    setGeneratingPrompts(true);
    try {
      await apiRequest('/api/v1/stage/6/prompts', { method: 'POST', body: {} });
      await onRefreshState();
      onNotify('Assembled 30-prompt batches & 100-prompt packs', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setGeneratingPrompts(false);
    }
  };

  const handlePushPackToBridge = async (packIndex: number) => {
    setPushingPack(packIndex);
    try {
      await apiRequest('/api/v1/stage/6/push-pack', {
        method: 'POST',
        body: { packIndex },
      });
      onNotify(`Pack #${packIndex} pushed to Extension Bridge`, 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setPushingPack(null);
    }
  };

  const handleGeneratePackaging = async () => {
    setGeneratingPackaging(true);
    try {
      await apiRequest('/api/v1/stage/7/packaging', { method: 'POST', body: {} });
      await onRefreshState();
      onNotify('Generated 3 Packaging Variants & verified Semantic Resonance Gate', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setGeneratingPackaging(false);
    }
  };

  const handleSelectPack = async (packId: 'PACK_A' | 'PACK_B' | 'PACK_C') => {
    setSelectingPack(packId);
    try {
      await apiRequest('/api/v1/stage/7/select-pack', {
        method: 'POST',
        body: { packId },
      });
      await onRefreshState();
      onNotify(`Selected ${packId} for Master Export`, 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSelectingPack(null);
    }
  };

  const handleDownloadMasterZip = async () => {
    if (!activeProject) return;
    setDownloadingZip(true);
    try {
      await downloadBundleZip(activeProject.id);
      onNotify('Master Bundle (.zip) downloaded', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setDownloadingZip(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    onNotify(`${label} copied`, 'success');
  };

  return (
    <div className="space-y-5 pb-28">
      {/* STAGE 6: 30-PROMPT BATCHES & 100-PROMPT PACKS */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-violet-400">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Visual Prompt Packs</h2>
              <p className="text-xs text-slate-400">30-Prompt Batches &amp; 100-Prompt Packs</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {isEstimatedTiming && (
              <span className="px-2 py-0.5 rounded-lg font-mono text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                ESTIMATED
              </span>
            )}
            <span
              className={`px-2.5 py-1 rounded-xl font-mono text-[11px] border ${
                wsConnected
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : 'bg-slate-800 text-slate-400 border-white/10'
              }`}
            >
              {wsConnected ? 'Bridge Connected' : 'Bridge Standby'}
            </span>
          </div>
        </div>

        {!s5Payload && (
          <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 px-3 py-2 rounded-xl">
            Slice the Storyboard in the Script/Transcript hub first to enable Visual Prompts.
          </div>
        )}

        <button
          type="button"
          onClick={handleGeneratePrompts}
          disabled={generatingPrompts || !activeProject || !s5Payload}
          className="w-full min-h-[44px] py-3.5 rounded-2xl bg-violet-500 hover:bg-violet-400 disabled:opacity-40 text-white font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
        >
          <Sparkles className="w-4 h-4" />
          {generatingPrompts ? 'Translating Visual Prompts...' : 'Generate Visual Prompts & Batches'}
        </button>

        {s6Payload && (
          <div className="space-y-3 pt-1">
            {s6Payload.styleSource === 'NEUTRAL_DEFAULT' && (
              <div className="px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-200 font-mono">
                Default style – set DNA to customise
              </div>
            )}
            <div className="flex items-center justify-between text-xs text-slate-300">
              <span>
                Total Prompts: <strong className="text-white">{s6Payload.totalPrompts}</strong>
              </span>
              <span>
                Batches (30/card): <strong className="text-emerald-400">{s6Payload.totalBatches}</strong> • Packs (100/file):{' '}
                <strong className="text-violet-300">{s6Payload.packCount}</strong>
              </span>
            </div>

            {/* 30-Prompt Batch Cards */}
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                30-Prompt Batch Copy Cards
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(s6Payload.batches || []).map((batch) => (
                  <div
                    key={batch.batchIndex}
                    className="liquid-glass-subtle p-3 flex items-center justify-between gap-2"
                  >
                    <div>
                      <div className="text-xs font-semibold text-white">{batch.label}</div>
                      <div className="text-[10px] font-mono text-slate-400">
                        Slots #{batch.startSlotIndex}–#{batch.endSlotIndex} ({batch.promptCount} prompts)
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(batch.content, batch.label)}
                      className="px-2.5 py-1.5 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1 active:scale-[0.97]"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Copy
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* 100-Prompt Pack Files */}
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                100-Prompt Pack Files
              </div>
              {(s6Payload.packs || []).map((pack) => (
                <div
                  key={pack.packIndex}
                  className="liquid-glass-subtle p-3 flex items-center justify-between gap-2"
                >
                  <div>
                    <div className="font-mono text-xs font-semibold text-white">
                      {pack.fileName}
                    </div>
                    <div className="text-[10px] font-mono text-slate-400">
                      {pack.promptCount} single-line prompts ( Slots #{pack.startSlotIndex}–#
                      {pack.endSlotIndex} )
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => copyToClipboard(pack.content, pack.fileName)}
                      className="px-2.5 py-1.5 rounded-xl bg-white/10 text-slate-200 text-xs flex items-center gap-1"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePushPackToBridge(pack.packIndex)}
                      disabled={pushingPack === pack.packIndex}
                      className="px-2.5 py-1.5 rounded-xl bg-violet-500/20 text-violet-300 border border-violet-500/30 text-xs font-semibold flex items-center gap-1"
                    >
                      <Send className="w-3.5 h-3.5" />
                      Push
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* STAGE 7: 3-PACK PACKAGING ENGINE, EMRI GATE (<20) & BUNDLE ARCHIVE */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <PackageCheck className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Packaging &amp; Master Bundle</h2>
              <p className="text-xs text-slate-400">3 Packs (A/B/C) + Resonance Gate (&lt; 20)</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {isEstimatedTiming && (
              <span className="px-2 py-0.5 rounded-lg font-mono text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                ESTIMATED
              </span>
            )}
            {s7Payload && (
              <span className="px-2.5 py-1 rounded-xl font-mono text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                EMRI {s7Payload.emri.emriScore.toFixed(1)}
              </span>
            )}
          </div>
        </div>

        {!s6Payload && (
          <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 px-3 py-2 rounded-xl">
            Generate Visual Prompts &amp; Batches above first to unlock 3-Pack Packaging.
          </div>
        )}

        <button
          type="button"
          onClick={handleGeneratePackaging}
          disabled={generatingPackaging || !s6Payload}
          className="w-full min-h-[44px] py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
        >
          <Sparkles className="w-4 h-4" />
          {generatingPackaging ? 'Building 3 Packs & Computing Resonance...' : 'Generate 3 Packaging Variants & SEO'}
        </button>

        {s7Payload && (
          <div className="space-y-4 pt-1">
            {/* 3 Packaging Cards */}
            <div className="space-y-2.5">
              {s7Payload.variants.map((pack) => {
                const isSelected = s7Payload.selectedPackId === pack.id;
                return (
                  <div
                    key={pack.id}
                    className={`liquid-glass-subtle p-4 space-y-2 border transition-all ${
                      isSelected ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-white/10'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-emerald-400">
                        {pack.variantName}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-lg font-mono text-[10px] font-semibold ${
                          pack.emri.passed
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-rose-500/20 text-rose-300'
                        }`}
                      >
                        EMRI {pack.emri.emriScore.toFixed(1)} ({pack.emri.passed ? 'PASS <20' : 'FAIL'})
                      </span>
                    </div>

                    <div className="text-sm font-bold text-white">{pack.title}</div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 font-mono text-xs font-bold">
                        Overlay: {pack.overlayText}
                      </span>
                      {pack.zeroWordOverlap && (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 text-[10px] font-mono">
                          Zero Title Overlap
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded-md bg-violet-500/15 text-violet-300 text-[10px] font-mono">
                        Scale {pack.subjectScalePercent}% • Safe Zone {pack.bottomRightSafeZonePct}%
                      </span>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed">
                      {pack.thumbnailPrompt}
                    </p>

                    <button
                      type="button"
                      onClick={() => handleSelectPack(pack.id)}
                      disabled={selectingPack === pack.id || !pack.emri.passed}
                      className={`w-full py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 ${
                        isSelected
                          ? 'bg-emerald-500 text-slate-950'
                          : 'bg-white/10 hover:bg-white/15 text-white'
                      }`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {isSelected ? 'Selected for Master Bundle' : `Select ${pack.id}`}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Above-the-Fold S-P-O Description & 4-Tier Tags */}
            <div className="liquid-glass-subtle p-3.5 space-y-2">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span className="font-semibold text-white">Above-the-Fold Description</span>
                <span className="font-mono">
                  {(s7Payload.seoMatrix?.aboveTheFoldDescription || '').length}/150 chars
                </span>
              </div>
              <p className="text-xs text-slate-200">
                {s7Payload.seoMatrix?.aboveTheFoldDescription}
              </p>

              <div className="pt-2 border-t border-white/10 space-y-1">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="font-semibold text-white flex items-center gap-1">
                    <Tag className="w-3 h-3 text-emerald-400" />
                    4-Tier Tags (10/20/40/30%)
                  </span>
                  <span className="font-mono">
                    {s7Payload.seoMatrix.fourTierTags?.totalCharCount ?? 0}/500 chars
                  </span>
                </div>
                <p className="font-mono text-[11px] text-emerald-300">
                  {s7Payload.seoMatrix.fourTierTags?.combinedCsv}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleDownloadMasterZip}
              disabled={downloadingZip || !s7Payload.selectedPackId}
              className="w-full py-4 rounded-2xl bg-gradient-to-r from-emerald-400 to-cyan-400 hover:from-emerald-300 hover:to-cyan-300 disabled:opacity-40 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 active:scale-[0.97]"
            >
              <Download className="w-4 h-4" />
              {downloadingZip ? 'Packaging Master Bundle...' : 'Download Master Bundle (.zip)'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
};
