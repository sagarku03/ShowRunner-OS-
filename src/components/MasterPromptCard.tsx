import React, { useState, useRef, useEffect } from 'react';
import {
  FileText,
  Sparkles,
  Upload,
  Trash2,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Lock,
  Layers,
  Palette,
  Mic,
  ShieldAlert,
} from 'lucide-react';
import type { MasterPromptState, ProjectItem, ChannelDnaRecord } from '../types/showrunner.ts';
import { apiRequest } from '../utils/apiClient.ts';
import { summariseProfile, type MasterPromptProfile, type Provenance } from '../../shared/rules/masterPromptProfile.ts';

interface MasterPromptCardProps {
  activeProject: ProjectItem | null;
  masterPromptState: MasterPromptState | null;
  channelDna: ChannelDnaRecord | null;
  hasValidKey: boolean;
  onRefreshState: () => Promise<void>;
  onNavigateHub?: (hub: 'vault' | 'topics' | 'studio' | 'script' | 'export') => void;
  onNotify: (msg: string, tone?: 'success' | 'warn' | 'error', err?: unknown) => void;
}

export const MasterPromptCard: React.FC<MasterPromptCardProps> = ({
  activeProject,
  masterPromptState,
  channelDna,
  hasValidKey,
  onRefreshState,
  onNavigateHub,
  onNotify,
}) => {
  const [text, setText] = useState<string>(masterPromptState?.text ?? '');
  const [analysing, setAnalysing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (masterPromptState?.text !== undefined) {
      setText(masterPromptState.text);
    }
  }, [masterPromptState?.text]);

  const profile: MasterPromptProfile | undefined = masterPromptState?.extracted?.profile;
  const isMasterPromptActive = Boolean(text.trim() && profile);

  const renderProvenanceChip = (prov?: Provenance) => {
    if (prov === 'EXPLICIT') {
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
          prompt
        </span>
      );
    }
    if (prov === 'INFERRED') {
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-500/20 text-purple-300 border border-purple-500/30">
          AI
        </span>
      );
    }
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-700/50 text-slate-400 border border-white/10">
        default
      </span>
    );
  };

  const handleFileUpload = (file: File) => {
    if (!file) return;
    const allowed = ['.txt', '.md', 'text/plain', 'text/markdown'];
    const isAllowed =
      allowed.some((ext) => file.name.toLowerCase().endsWith(ext)) ||
      allowed.includes(file.type);
    if (!isAllowed) {
      onNotify('Please select a text or markdown file (.txt, .md)', 'warn');
      return;
    }

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      let content = String(e.target?.result ?? '');
      // Strip BOM if present
      if (content.charCodeAt(0) === 0xfeff) {
        content = content.slice(1);
      }
      setText(content);
      onNotify(`Loaded "${file.name}" (${(file.size / 1024).toFixed(1)} KB)`, 'success');
    };
    reader.onerror = () => {
      onNotify('Failed to read uploaded file', 'error');
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  const handleAnalyseAndUnlock = async () => {
    if (!activeProject) {
      onNotify('Select or create a project first', 'warn');
      return;
    }
    setAnalysing(true);
    try {
      const res = await apiRequest<{
        masterPrompt: MasterPromptState;
        extractionError?: string;
      }>('/api/v1/stage/0/master-prompt', {
        method: 'PUT',
        body: {
          text,
          skipLlmExtraction: !hasValidKey,
        },
      });

      await onRefreshState();

      if (res.extractionError) {
        onNotify(
          `Master Prompt saved! Offline deterministic profile locked. (Note: ${res.extractionError})`,
          'warn'
        );
      } else {
        onNotify('Master Prompt parsed and production engine unlocked!', 'success');
      }
    } catch (err) {
      onNotify('Failed to analyse and save Master Prompt', 'error', err);
    } finally {
      setAnalysing(false);
    }
  };

  const handleClear = async () => {
    if (!activeProject) return;
    setText('');
    setFileName('');
    setAnalysing(true);
    try {
      await apiRequest('/api/v1/stage/0/master-prompt', {
        method: 'PUT',
        body: { text: '' },
      });
      await onRefreshState();
      onNotify('Master Prompt cleared. Reverted to Universal Creator Mode.', 'success');
    } catch (err) {
      onNotify('Failed to clear Master Prompt', 'error', err);
    } finally {
      setAnalysing(false);
    }
  };

  const summary = profile ? summariseProfile(profile) : null;

  return (
    <section className="liquid-glass p-5 space-y-4 border-emerald-500/40 relative overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-white">
                1. Master Prompt & Channel Profile
              </h2>
              {isMasterPromptActive && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  Unlocked
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              Paste your Channel Master Prompt to auto-fill every tool setting, budget, and style lock
            </p>
          </div>
        </div>

        {text && (
          <button
            type="button"
            onClick={handleClear}
            disabled={analysing}
            className="px-3 py-1.5 rounded-xl bg-slate-800/80 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-white/10 text-xs flex items-center gap-1 transition-colors min-h-[44px]"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        )}
      </div>

      {/* File Drop & Paste Area */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`relative rounded-2xl border transition-all ${
          dragOver
            ? 'border-emerald-400 bg-emerald-500/10'
            : 'border-white/10 bg-slate-900/80'
        }`}
      >
        <textarea
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Paste your entire Master Prompt here...\n\nExample:\nYou are "FactLock", YouTube science storyteller. Channel: @factlock. Language: Hinglish (Devanagari voiceover). Word budget: 2000–2400 words. Chapters: Ch 1 Hook, Ch 2 Anomaly... Style prefix: "hyper-realistic forensic macro...". Zero 3D render...`}
          className="w-full p-3.5 rounded-2xl bg-transparent border-0 text-xs text-white leading-relaxed focus:outline-none focus:ring-0 placeholder:text-slate-500"
        />

        <div className="p-3 border-t border-white/5 flex flex-wrap items-center justify-between gap-2 text-xs bg-black/20 rounded-b-2xl">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  handleFileUpload(e.target.files[0]);
                }
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/10 flex items-center gap-1.5 min-h-[44px]"
            >
              <Upload className="w-3.5 h-3.5 text-emerald-400" />
              <span>{fileName ? `File: ${fileName}` : 'Upload file (.txt / .md)'}</span>
            </button>
            <span className="text-[11px] text-slate-400">or drag & drop</span>
          </div>

          <div className="flex items-center gap-3 text-[11px] text-slate-400 font-mono">
            <span>{text.length} chars</span>
            <span>{text.trim() ? text.trim().split(/\s+/).length : 0} words</span>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-2.5">
        <button
          type="button"
          disabled={analysing || !activeProject || !text.trim()}
          onClick={handleAnalyseAndUnlock}
          className="flex-1 py-3 px-4 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 transition-all active:scale-[0.98] min-h-[44px]"
        >
          <Sparkles className="w-4 h-4" />
          <span>{analysing ? 'Analysing & Unlocking...' : 'Analyse & Unlock Tool'}</span>
        </button>

        {isMasterPromptActive && onNavigateHub && (
          <button
            type="button"
            onClick={() => onNavigateHub('topics')}
            className="py-3 px-5 rounded-2xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 border border-cyan-500/40 text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-[0.98] min-h-[44px]"
          >
            <span>Next: Topics & Research</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Warnings Callout */}
      {profile && profile.warnings && profile.warnings.length > 0 && (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 space-y-1.5">
          <div className="flex items-center gap-1.5 text-amber-300 text-xs font-semibold">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Master Prompt Consistency Warnings</span>
          </div>
          <ul className="text-[11px] text-amber-200/90 list-disc list-inside space-y-0.5">
            {profile.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Extracted Settings Preview (Unlocked Parameters) */}
      {profile && summary && (
        <div className="liquid-glass-subtle p-4 space-y-3.5 rounded-2xl">
          <div className="flex items-center justify-between border-b border-white/5 pb-2">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-semibold text-white">
                Unlocked Production Engine Parameters
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
              <span>Provenance:</span>
              <span className="text-emerald-300 font-mono">prompt</span>
              <span>•</span>
              <span className="text-purple-300 font-mono">AI</span>
              <span>•</span>
              <span className="text-slate-400 font-mono">default</span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 text-xs">
            {/* Persona & Channel */}
            <div className="p-2.5 rounded-xl bg-slate-950/60 border border-white/5 space-y-1">
              <div className="flex items-center justify-between text-slate-400 text-[10px]">
                <span>Channel & Persona</span>
                {renderProvenanceChip(profile.identity.channelName?.provenance)}
              </div>
              <div className="font-semibold text-white truncate">
                {profile.identity.spokenChannelName?.value || profile.identity.channelName?.value || 'FactLock'}
              </div>
              <div className="text-[11px] text-slate-400 truncate">
                {profile.identity.persona.value || 'Curious scientific explorer'}
              </div>
            </div>

            {/* Language & Script */}
            <div className="p-2.5 rounded-xl bg-slate-950/60 border border-white/5 space-y-1">
              <div className="flex items-center justify-between text-slate-400 text-[10px]">
                <span>Language / Script</span>
                {renderProvenanceChip(profile.language.voiceoverLanguage.provenance)}
              </div>
              <div className="font-semibold text-emerald-300">
                {profile.language.voiceoverLanguage.value} ({profile.language.script.value})
              </div>
              <div className="text-[11px] text-slate-400">
                UI: {profile.language.uiLanguage.value}
              </div>
            </div>

            {/* Word Budget & Runtime */}
            <div className="p-2.5 rounded-xl bg-slate-950/60 border border-white/5 space-y-1">
              <div className="flex items-center justify-between text-slate-400 text-[10px]">
                <span>Word Budget & Pace</span>
                {renderProvenanceChip(profile.budget.wordBudgetMin.provenance)}
              </div>
              <div className="font-semibold text-white">
                {summary.wordBudget}
              </div>
              <div className="text-[11px] text-slate-400">
                {summary.estimatedRuntime} @ {profile.budget.wpm.value ?? 160} WPM
              </div>
            </div>

            {/* Visual Style & Anchor */}
            <div className="p-2.5 rounded-xl bg-slate-950/60 border border-white/5 space-y-1 sm:col-span-2">
              <div className="flex items-center justify-between text-slate-400 text-[10px]">
                <span className="flex items-center gap-1">
                  <Palette className="w-3 h-3 text-cyan-400" />
                  Visual Style & Style Prefix
                </span>
                {renderProvenanceChip(profile.visual.stylePrefix.provenance)}
              </div>
              <div className="text-[11px] text-cyan-200 line-clamp-2">
                {profile.visual.stylePrefix.value || '16:9 widescreen cinematic'}
              </div>
              {profile.visual.characterAnchor.value && (
                <div className="text-[10px] text-slate-400 truncate">
                  Anchor: <span className="text-white">{profile.visual.characterAnchor.value}</span>
                </div>
              )}
            </div>

            {/* Cut Pacing & Mode */}
            <div className="p-2.5 rounded-xl bg-slate-950/60 border border-white/5 space-y-1">
              <div className="flex items-center justify-between text-slate-400 text-[10px]">
                <span>Cuts & Mode</span>
                {renderProvenanceChip(profile.pacing.cutMinSec.provenance)}
              </div>
              <div className="font-semibold text-white">
                {summary.cuts}
              </div>
              <div className="text-[11px] text-purple-300">
                Mode: {profile.pacing.recommendedMode.value ?? 'MODE_1_IMAGE'}
              </div>
            </div>
          </div>

          {/* Chapters & Structure */}
          {profile.chapters.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Chapters ({profile.chapters.length})</span>
                <span className="font-mono text-[10px]">
                  {profile.chapters.map((c) => `${c.name} (${c.sharePct}%)`).join(' • ')}
                </span>
              </div>
            </div>
          )}

          {/* Banned Words & Blacklist stats */}
          <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-slate-400 border-t border-white/5">
            <div>
              Banned words:{' '}
              <strong className="text-rose-300 font-mono">
                {profile.rules.bannedWords.length}
              </strong>
            </div>
            <div>•</div>
            <div>
              Published blacklist:{' '}
              <strong className="text-amber-300 font-mono">
                {profile.blacklist.length} videos
              </strong>
            </div>
            {profile.budget.ctaKeyword.value && (
              <>
                <div>•</div>
                <div>
                  CTA lock:{' '}
                  <strong className="text-emerald-300 font-mono">
                    "{profile.budget.ctaKeyword.value}"
                  </strong>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
