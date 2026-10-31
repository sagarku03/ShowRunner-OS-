import React, { useState } from 'react';
import {
  Dna,
  Lock,
  Sparkles,
  Youtube,
  Compass,
  Layers,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Sliders,
  X,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import type {
  ChannelDnaRecord,
  NicheStyleOption,
  ProjectItem,
} from '../types/showrunner.ts';
import { apiRequest } from '../utils/apiClient.ts';

interface ChannelDnaWizardProps {
  activeProject: ProjectItem;
  initialDna: ChannelDnaRecord | null;
  hasValidKey: boolean;
  onClose: () => void;
  onLocked: (dna: ChannelDnaRecord) => Promise<void>;
  onJumpToExpress?: () => void;
  onNotify: (msg: string, tone?: 'success' | 'warn' | 'error', err?: unknown) => void;
}

type WizardPath = 'CHANNEL' | 'NICHE' | 'HYBRID';

export const ChannelDnaWizard: React.FC<ChannelDnaWizardProps> = ({
  activeProject,
  initialDna,
  hasValidKey,
  onClose,
  onLocked,
  onJumpToExpress,
  onNotify,
}) => {
  const [step, setStep] = useState<'PATH' | 'INPUT' | 'OPTIONS' | 'REVIEW'>(
    initialDna ? 'REVIEW' : 'PATH'
  );
  const [pathChoice, setPathChoice] = useState<WizardPath>(
    initialDna?.source === 'CHANNEL' || initialDna?.source === 'ANALYSED'
      ? 'CHANNEL'
      : initialDna?.source === 'HYBRID'
        ? 'HYBRID'
        : 'NICHE'
  );

  // Path A inputs
  const [channelInput, setChannelInput] = useState(
    initialDna?.channelMeta?.handle || ''
  );
  const [depth, setDepth] = useState<'QUICK' | 'STANDARD' | 'DEEP'>('STANDARD');
  const [manualUrlsText, setManualUrlsText] = useState('');

  // Path B inputs
  const [nicheInput, setNicheInput] = useState(activeProject.niche || '');
  const [subNicheInput, setSubNicheInput] = useState(
    initialDna?.identity?.subNiche || ''
  );
  const [primaryLang, setPrimaryLang] = useState(
    initialDna?.language?.primary || 'hi'
  );
  const [scriptName, setScriptName] = useState(
    initialDna?.language?.script || 'Devanagari'
  );
  const [formatPreset, setFormatPreset] = useState<
    'DOCUMENTARY' | 'EXPLAINER' | 'STORYTIME' | 'LISTICLE'
  >('EXPLAINER');
  const [toneInput, setToneInput] = useState('Investigative, high-clarity, direct');
  const [visualPref, setVisualPref] = useState('High-contrast cinematic macro');
  const [avoidTopicsText, setAvoidTopicsText] = useState('');

  // Path C inputs
  const [refChannel1, setRefChannel1] = useState('');
  const [refChannel2, setRefChannel2] = useState('');
  const [refChannel3, setRefChannel3] = useState('');

  // Results & editing state
  const [analysing, setAnalysing] = useState(false);
  const [phaseLabel, setPhaseLabel] = useState('');
  const [styleOptions, setStyleOptions] = useState<NicheStyleOption[]>([]);
  const [draftDna, setDraftDna] = useState<ChannelDnaRecord | null>(initialDna);
  const [fidelity, setFidelity] = useState<number>(initialDna?.fidelity ?? 70);
  const [showEvidenceDrawer, setShowEvidenceDrawer] = useState(false);
  const [locking, setLocking] = useState(false);

  const handleRunAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasValidKey) {
      onNotify(
        'No VALID Gemini API key found. Add and test a key in the Vault first.',
        'error'
      );
      return;
    }

    setAnalysing(true);
    try {
      if (pathChoice === 'CHANNEL') {
        setPhaseLabel('Fetching channel videos & computing deterministic metrics...');
        const manualVideoUrls = manualUrlsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        const res = await apiRequest<{ dnaDraft: ChannelDnaRecord }>(
          '/api/v1/stage/0/dna/analyse-channel',
          {
            method: 'POST',
            body: {
              channelInput: channelInput.trim(),
              depth,
              manualVideoUrls: manualVideoUrls.length > 0 ? manualVideoUrls : undefined,
              languageOverride: { primary: primaryLang, script: scriptName },
              fidelity,
            },
          }
        );
        setDraftDna(res.dnaDraft);
        setStep('REVIEW');
        onNotify('Channel DNA extracted from video sample', 'success');
      } else if (pathChoice === 'NICHE') {
        setPhaseLabel('Running 2-step grounded Niche Intelligence research...');
        const res = await apiRequest<{ options: NicheStyleOption[] }>(
          '/api/v1/stage/0/dna/analyse-niche',
          {
            method: 'POST',
            body: {
              niche: nicheInput.trim() || activeProject.niche,
              subNiche: subNicheInput.trim() || undefined,
              language: primaryLang,
              script: scriptName,
              formatPreset,
              tone: toneInput.trim(),
              visualPreference: visualPref.trim(),
              avoidTopics: avoidTopicsText
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            },
          }
        );
        setStyleOptions(res.options || []);
        if (res.options && res.options.length > 0) {
          setDraftDna(res.options[0].channelDna);
          setStep('OPTIONS');
        }
        onNotify('Generated 3 grounded Style Options for your niche', 'success');
      } else {
        setPhaseLabel('Analysing reference channels & building hybrid DNA...');
        const channels = [refChannel1, refChannel2, refChannel3]
          .map((c) => c.trim())
          .filter(Boolean)
          .map((channelInputItem) => ({ channelInput: channelInputItem }));
        const res = await apiRequest<{ dnaDraft: ChannelDnaRecord }>(
          '/api/v1/stage/0/dna/analyse-references',
          {
            method: 'POST',
            body: {
              channels,
              languageOverride: { primary: primaryLang, script: scriptName },
              fidelity,
            },
          }
        );
        setDraftDna(res.dnaDraft);
        setStep('REVIEW');
        onNotify('Synthesised Hybrid Reference DNA with anti-cloning guard', 'success');
      }
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setAnalysing(false);
      setPhaseLabel('');
    }
  };

  const handleLockDna = async () => {
    if (!draftDna) return;
    setLocking(true);
    try {
      const updatedDna: ChannelDnaRecord = {
        ...draftDna,
        fidelity,
      };
      const res = await apiRequest<{ dnaRecord: ChannelDnaRecord }>(
        '/api/v1/stage/0/dna/lock',
        {
          method: 'POST',
          body: { dna: updatedDna },
        }
      );
      await onLocked(res.dnaRecord);
      onNotify(`Channel DNA v${res.dnaRecord.version} locked!`, 'success');
      onClose();
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setLocking(false);
    }
  };

  const renderConfidenceBadge = (level?: 'HIGH' | 'MEDIUM' | 'LOW') => {
    const c = level ?? 'MEDIUM';
    const colors =
      c === 'HIGH'
        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
        : c === 'MEDIUM'
          ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
          : 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    return (
      <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono border ${colors}`}>
        {c}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xl overflow-y-auto p-4">
      <div className="max-w-lg mx-auto liquid-glass p-5 space-y-4 my-4 border-emerald-500/30">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Dna className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">
                Stage S0B — Channel DNA &amp; Style Lock
              </h2>
              <p className="text-[11px] text-slate-400">
                Universal Style Profile for Any Niche &amp; Language
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close DNA Wizard"
            className="p-1.5 rounded-xl bg-slate-900/80 text-slate-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === 'PATH' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-300">
              Do you have an existing YouTube channel, or are you building a new channel from a
              niche or reference channels?
            </p>

            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => {
                  setPathChoice('CHANNEL');
                  setStep('INPUT');
                }}
                className="w-full p-4 rounded-2xl bg-slate-900/80 hover:bg-emerald-500/10 border border-white/10 hover:border-emerald-500/40 text-left flex items-start gap-3 transition-all"
              >
                <Youtube className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-white">
                    Yes — Analyse My Existing YouTube Channel
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Extracts title archetypes, pacing WPM, hook structure, and visual voice from
                    your channel videos.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setPathChoice('NICHE');
                  setStep('INPUT');
                }}
                className="w-full p-4 rounded-2xl bg-slate-900/80 hover:bg-emerald-500/10 border border-white/10 hover:border-emerald-500/40 text-left flex items-start gap-3 transition-all"
              >
                <Compass className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-white">
                    No, New Channel — Grounded Niche Intelligence
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Researches top formats in your niche and builds 3 distinct Style Options to
                    choose from.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setPathChoice('HYBRID');
                  setStep('INPUT');
                }}
                className="w-full p-4 rounded-2xl bg-slate-900/80 hover:bg-violet-500/10 border border-white/10 hover:border-violet-500/40 text-left flex items-start gap-3 transition-all"
              >
                <Layers className="w-5 h-5 text-violet-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-white">
                    Use 1–3 Reference Channels (Hybrid Inspiration)
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Blends structural DNA from up to 3 channels with an automatic similarity guard
                    (&le; 0.78) to prevent cloning.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  onClose();
                  onJumpToExpress?.();
                }}
                className="w-full p-4 rounded-2xl bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/40 text-left flex items-start gap-3 transition-all"
              >
                <Sparkles className="w-5 h-5 text-violet-300 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-white">
                    I already have my voiceover transcript (Express)
                  </div>
                  <p className="text-[11px] text-slate-300 mt-0.5">
                    Skip Topics, Research &amp; Script — lock Quick Style inline, upload your .vtt/.srt/.json transcript, and slice your storyboard immediately.
                  </p>
                </div>
              </button>
            </div>
          </div>
        )}

        {step === 'INPUT' && (
          <form onSubmit={handleRunAnalysis} className="space-y-3">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep('PATH')}
                className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
              <span className="text-[11px] font-mono text-emerald-400">
                Source: {pathChoice}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Primary Language
                </label>
                <select
                  value={primaryLang}
                  onChange={(e) => {
                    const lang = e.target.value;
                    setPrimaryLang(lang);
                    if (lang === 'en' || lang === 'es') setScriptName('Latin');
                    if (lang === 'hi') setScriptName('Devanagari');
                  }}
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                >
                  <option value="hi">Hindi / Hinglish (hi)</option>
                  <option value="en">English (en)</option>
                  <option value="es">Spanish (es)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Spoken Script (Box 2 TTS)
                </label>
                <select
                  value={scriptName}
                  onChange={(e) => setScriptName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                >
                  <option value="Devanagari">Devanagari (Pure Hindi TTS)</option>
                  <option value="Latin">Latin (English / Spanish TTS)</option>
                </select>
              </div>
            </div>

            {pathChoice === 'CHANNEL' && (
              <>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    YouTube Channel URL, @handle, or Channel ID (UC...)
                  </label>
                  <input
                    type="text"
                    required
                    value={channelInput}
                    onChange={(e) => setChannelInput(e.target.value)}
                    placeholder="e.g. @Veritasium or UC..."
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Analysis Depth
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['QUICK', 'STANDARD', 'DEEP'] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDepth(d)}
                        className={`py-2 rounded-xl text-xs font-mono border ${
                          depth === d
                            ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                            : 'bg-slate-900 border-white/10 text-slate-400'
                        }`}
                      >
                        {d} ({d === 'QUICK' ? 4 : d === 'STANDARD' ? 8 : 15})
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Optional Fallback Video URLs (one per line, min 5 if no RSS/API)
                  </label>
                  <textarea
                    rows={3}
                    value={manualUrlsText}
                    onChange={(e) => setManualUrlsText(e.target.value)}
                    placeholder="https://youtube.com/watch?v=..."
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white font-mono"
                  />
                </div>
              </>
            )}

            {pathChoice === 'NICHE' && (
              <>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Channel Niche
                  </label>
                  <input
                    type="text"
                    required
                    value={nicheInput}
                    onChange={(e) => setNicheInput(e.target.value)}
                    placeholder="e.g. Personal finance for students, Retro gaming history, Hindi stand-up recaps"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Sub-niche
                    </label>
                    <input
                      type="text"
                      value={subNicheInput}
                      onChange={(e) => setSubNicheInput(e.target.value)}
                      placeholder="e.g. Index funds & behavioral traps"
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Format Preset
                    </label>
                    <select
                      value={formatPreset}
                      onChange={(e) =>
                        setFormatPreset(
                          e.target.value as
                            | 'DOCUMENTARY'
                            | 'EXPLAINER'
                            | 'STORYTIME'
                            | 'LISTICLE'
                        )
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                    >
                      <option value="EXPLAINER">Explainer</option>
                      <option value="DOCUMENTARY">Deep-Dive Investigation</option>
                      <option value="STORYTIME">Case-Study Storytime</option>
                      <option value="LISTICLE">Structured Breakdown</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Tone & Voice
                    </label>
                    <input
                      type="text"
                      value={toneInput}
                      onChange={(e) => setToneInput(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Visual Aesthetic
                    </label>
                    <input
                      type="text"
                      value={visualPref}
                      onChange={(e) => setVisualPref(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Anti-Topics to Avoid (comma separated)
                  </label>
                  <input
                    type="text"
                    value={avoidTopicsText}
                    onChange={(e) => setAvoidTopicsText(e.target.value)}
                    placeholder="e.g. Crypto pump schemes, unverified rumors"
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                  />
                </div>
              </>
            )}

            {pathChoice === 'HYBRID' && (
              <div className="space-y-2.5">
                <p className="text-[11px] text-slate-400">
                  Enter 1 to 3 reference channels (@handle or UC channel ID).
                </p>
                <input
                  type="text"
                  required
                  value={refChannel1}
                  onChange={(e) => setRefChannel1(e.target.value)}
                  placeholder="Reference Channel #1 (required)"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                />
                <input
                  type="text"
                  value={refChannel2}
                  onChange={(e) => setRefChannel2(e.target.value)}
                  placeholder="Reference Channel #2 (optional)"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                />
                <input
                  type="text"
                  value={refChannel3}
                  onChange={(e) => setRefChannel3(e.target.value)}
                  placeholder="Reference Channel #3 (optional)"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-white/10 text-xs text-white"
                />
              </div>
            )}

            {analysing && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-center gap-2">
                <Sparkles className="w-4 h-4 animate-spin shrink-0" />
                <span>{phaseLabel || 'Running Channel DNA analysis...'}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={analysing || !hasValidKey}
              title={!hasValidKey ? 'Add and validate a Gemini API key first' : undefined}
              className="w-full py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5"
            >
              <Sparkles className="w-4 h-4" />
              {analysing ? 'Analysing DNA...' : 'Analyse & Synthesise Channel DNA'}
            </button>
          </form>
        )}

        {step === 'OPTIONS' && styleOptions.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep('INPUT')}
                className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
              <span className="text-xs font-semibold text-emerald-400">
                Choose 1 of 3 Grounded Style Options
              </span>
            </div>

            {styleOptions.map((opt) => (
              <div
                key={opt.id}
                className="p-4 rounded-2xl bg-slate-900/90 border border-white/10 hover:border-emerald-500/40 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">{opt.label}</span>
                  <span className="font-mono text-[10px] text-emerald-400">
                    {opt.channelDna?.pacingAndMetrics?.wpm ?? (opt.channelDna as any)?.voice?.wpm ?? 187.41} WPM •{' '}
                    {opt.channelDna?.language?.script ?? 'Devanagari'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-300">{opt.tagline}</p>
                <div className="text-[10px] text-slate-400">
                  Visual: {opt.channelDna?.visualDirection?.aesthetic ?? (opt.channelDna as any)?.visuals?.style ?? 'Cinematic Realism'}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDraftDna(opt.channelDna);
                    setStep('REVIEW');
                  }}
                  className="w-full py-2 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center justify-center gap-1"
                >
                  <span>Select & Customise Style</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {step === 'REVIEW' && draftDna && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep('PATH')}
                className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Change Source
              </button>
              <span className="font-mono text-[11px] text-emerald-400">
                Source: {draftDna.source} • {draftDna.language.primary} (
                {draftDna.language.script})
              </span>
            </div>

            {/* Fidelity Slider (C7) */}
            <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-white/10 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-emerald-400" />
                  Style Fidelity Slider
                </span>
                <span className="font-mono text-emerald-400 font-bold">{fidelity}/100</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={fidelity}
                onChange={(e) => setFidelity(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>0 = Loose Inspiration</span>
                <span>70 = Balanced</span>
                <span>100 = Strict Lock</span>
              </div>
            </div>

            {/* 8 Editable DNA Layer Cards */}
            <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1">
              <div className="p-3 rounded-xl bg-slate-900/70 border border-white/10 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">
                    1. Identity & Positioning
                  </span>
                  {renderConfidenceBadge(draftDna.confidence?.identity)}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={draftDna.identity.niche}
                    onChange={(e) =>
                      setDraftDna({
                        ...draftDna,
                        identity: { ...draftDna.identity, niche: e.target.value },
                      })
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-white/10 text-xs text-white"
                    placeholder="Channel Niche"
                  />
                  <input
                    type="text"
                    value={draftDna.identity.subNiche}
                    onChange={(e) =>
                      setDraftDna({
                        ...draftDna,
                        identity: { ...draftDna.identity, subNiche: e.target.value },
                      })
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-white/10 text-xs text-white"
                    placeholder="Sub-niche"
                  />
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/70 border border-white/10 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">
                    2. Pacing, WPM & Sentence Bounds
                  </span>
                  {renderConfidenceBadge(draftDna.confidence?.pacingAndMetrics)}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-400">WPM</label>
                    <input
                      type="number"
                      step="0.5"
                      value={draftDna.pacingAndMetrics.wpm}
                      onChange={(e) =>
                        setDraftDna({
                          ...draftDna,
                          pacingAndMetrics: {
                            ...draftDna.pacingAndMetrics,
                            wpm: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full px-2 py-1 rounded-lg bg-slate-950 border border-white/10 text-xs text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400">Min Words/Sent</label>
                    <input
                      type="number"
                      value={draftDna.pacingAndMetrics.sentenceLengthMin}
                      onChange={(e) =>
                        setDraftDna({
                          ...draftDna,
                          pacingAndMetrics: {
                            ...draftDna.pacingAndMetrics,
                            sentenceLengthMin: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full px-2 py-1 rounded-lg bg-slate-950 border border-white/10 text-xs text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400">Max Words/Sent</label>
                    <input
                      type="number"
                      value={draftDna.pacingAndMetrics.sentenceLengthMax}
                      onChange={(e) =>
                        setDraftDna({
                          ...draftDna,
                          pacingAndMetrics: {
                            ...draftDna.pacingAndMetrics,
                            sentenceLengthMax: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full px-2 py-1 rounded-lg bg-slate-950 border border-white/10 text-xs text-white font-mono"
                    />
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/70 border border-white/10 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">
                    3. Hook DNA & Open-Loop Cadence
                  </span>
                  {renderConfidenceBadge(draftDna.confidence?.hookDNA)}
                </div>
                <input
                  type="text"
                  value={draftDna.hookDNA.first15sPattern}
                  onChange={(e) =>
                    setDraftDna({
                      ...draftDna,
                      hookDNA: { ...draftDna.hookDNA, first15sPattern: e.target.value },
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-white/10 text-xs text-white"
                />
              </div>

              <div className="p-3 rounded-xl bg-slate-900/70 border border-white/10 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">
                    4. Visual Direction & Lighting
                  </span>
                  {renderConfidenceBadge(draftDna.confidence?.visualDirection)}
                </div>
                <input
                  type="text"
                  value={draftDna.visualDirection.aesthetic}
                  onChange={(e) =>
                    setDraftDna({
                      ...draftDna,
                      visualDirection: {
                        ...draftDna.visualDirection,
                        aesthetic: e.target.value,
                      },
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-white/10 text-xs text-white"
                />
              </div>
            </div>

            {/* Evidence Drawer toggle */}
            <button
              type="button"
              onClick={() => setShowEvidenceDrawer((v) => !v)}
              className="w-full py-2 px-3 rounded-xl bg-slate-900/90 border border-white/10 text-xs text-slate-300 flex items-center justify-between"
            >
              <span>
                Evidence Citations ({draftDna.titleArchetypes.length} verified title patterns)
              </span>
              {showEvidenceDrawer ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>

            {showEvidenceDrawer && (
              <div className="p-3 rounded-xl bg-slate-950 border border-white/10 space-y-1.5 text-[11px] text-slate-300 font-mono">
                {draftDna.titleArchetypes.map((arch, i) => (
                  <div key={i} className="border-b border-white/5 pb-1 last:border-0">
                    <div className="text-emerald-300">{arch.pattern}</div>
                    <div className="text-[10px] text-slate-400">
                      Citations:{' '}
                      {arch.evidence
                        .map((ev) => `${ev.videoId}:${ev.field}`)
                        .join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={handleLockDna}
              disabled={locking}
              className="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
            >
              <Lock className="w-4 h-4" />
              {locking ? 'Locking Channel DNA...' : 'Confirm & Lock Channel DNA'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
