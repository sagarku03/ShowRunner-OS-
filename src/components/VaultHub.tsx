import React, { useState } from 'react';
import {
  KeyRound,
  Plus,
  Trash2,
  RefreshCw,
  Sliders,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Film,
  Gauge,
  BadgeCheck,
  Dna,
  FileText,
  FlaskConical,
  Unlock,
  ShieldBan,
  Activity,
  Terminal,
  Copy,
  ClipboardCheck,
} from 'lucide-react';
import type { GenerationMode, VideoProvider } from '../config/constants.ts';
import {
  OMNI_FLASH_DURATIONS,
  UNIVERSAL_CREATOR_MODE_LABEL,
  VEO_3_1_FIXED_DURATION,
  WPM_MAX,
  WPM_MIN,
} from '../config/constants.ts';
import type {
  ChannelDnaRecord,
  DiagnosticsData,
  LlmHealthData,
  MasterPromptExtraction,
  MasterPromptState,
  ModelDiscoveryData,
  ProjectItem,
  VaultKeyItem,
} from '../types/showrunner.ts';
import { apiRequest } from '../utils/apiClient.ts';
import { ChannelDnaWizard } from './ChannelDnaWizard.tsx';

interface VaultHubProps {
  keys: VaultKeyItem[];
  activeProject: ProjectItem | null;
  channelDna: ChannelDnaRecord | null;
  masterPromptState: MasterPromptState | null;
  llmHealth: LlmHealthData | null;
  onRefreshState: () => Promise<void>;
  onNavigateHub?: (hub: 'vault' | 'topics' | 'studio' | 'script' | 'export') => void;
  onNotify: (msg: string, tone?: 'success' | 'warn' | 'error', err?: unknown) => void;
}

const EMPTY_EXTRACTED_SETTINGS: MasterPromptExtraction = {
  persona: '',
  customChapters: [],
  brandName: '',
  negativePrompts: [],
  toneWords: [],
  bannedWords: [],
};

function safeExtractedSettings(raw?: Partial<MasterPromptExtraction> | null): MasterPromptExtraction {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_EXTRACTED_SETTINGS };
  }
  return {
    persona: typeof raw.persona === 'string' ? raw.persona : '',
    customChapters: Array.isArray(raw.customChapters) ? raw.customChapters : [],
    brandName: typeof raw.brandName === 'string' ? raw.brandName : '',
    negativePrompts: Array.isArray(raw.negativePrompts) ? raw.negativePrompts : [],
    toneWords: Array.isArray(raw.toneWords) ? raw.toneWords : [],
    bannedWords: Array.isArray(raw.bannedWords) ? raw.bannedWords : [],
  };
}

export const VaultHub: React.FC<VaultHubProps> = ({
  keys,
  activeProject,
  channelDna,
  masterPromptState,
  llmHealth,
  onRefreshState,
  onNavigateHub,
  onNotify,
}) => {
  const [rawKey, setRawKey] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [keyType, setKeyType] = useState<'GEMINI' | 'YOUTUBE'>('GEMINI');
  const [busyKey, setBusyKey] = useState(false);
  const [testingKeyId, setTestingKeyId] = useState<number | null>(null);

  const [discovery, setDiscovery] = useState<ModelDiscoveryData | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  const [brandName, setBrandName] = useState<string>(
    activeProject?.brandName ?? 'FactLock'
  );
  const [reasoningModel, setReasoningModel] = useState<string>(
    activeProject?.reasoningModel ?? ''
  );
  const [fastModel, setFastModel] = useState<string>(activeProject?.fastModel ?? '');
  const [embeddingModel, setEmbeddingModel] = useState<string>(
    activeProject?.embeddingModel ?? ''
  );
  const [smartTiering, setSmartTiering] = useState<boolean>(
    activeProject?.smartTiering ?? true
  );
  const [generationMode, setGenerationMode] = useState<GenerationMode>(
    activeProject?.generationMode ?? 'MODE_2_VIDEO'
  );
  const [videoProvider, setVideoProvider] = useState<VideoProvider>(
    activeProject?.videoProvider ?? 'VEO_3_1'
  );
  const [clipDuration, setClipDuration] = useState<number>(
    activeProject?.defaultClipDuration ?? VEO_3_1_FIXED_DURATION
  );
  const [configuredWpm, setConfiguredWpm] = useState<number>(
    activeProject?.configuredWpm ?? 187.41
  );
  const [targetDuration, setTargetDuration] = useState<number>(
    activeProject?.targetDuration ?? 11
  );

  // Part B: Master Prompt Override state
  const [masterPromptText, setMasterPromptText] = useState<string>(
    masterPromptState?.text ?? activeProject?.masterPrompt ?? ''
  );
  const [extractedSettings, setExtractedSettings] = useState<MasterPromptExtraction>(() =>
    safeExtractedSettings(masterPromptState?.extracted ?? activeProject?.masterPromptExtracted)
  );
  const [analysingMasterPrompt, setAnalysingMasterPrompt] = useState(false);

  // Part C: Channel DNA Wizard state
  const [showDnaWizard, setShowDnaWizard] = useState(false);

  // Blacklist quick add in Vault (C10 item 7)
  const [blacklistInput, setBlacklistInput] = useState('');

  // Part P3.6 Diagnostics state
  const [diagnostics, setDiagnostics] = useState<DiagnosticsData | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);

  const handleFetchDiagnostics = async () => {
    setLoadingDiagnostics(true);
    try {
      const res = await apiRequest<DiagnosticsData>('/api/v1/diagnostics');
      setDiagnostics(res);
      onNotify('System diagnostics loaded', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setLoadingDiagnostics(false);
    }
  };

  const handleCopyDiagnostics = () => {
    if (!diagnostics) return;
    const text = JSON.stringify(diagnostics, null, 2);
    void navigator.clipboard?.writeText(text);
    setCopiedDiag(true);
    setTimeout(() => setCopiedDiag(false), 2000);
    onNotify('Diagnostics copied to clipboard', 'success');
  };

  React.useEffect(() => {
    if (activeProject) {
      setBrandName(activeProject.brandName ?? 'FactLock');
      setReasoningModel(activeProject.reasoningModel ?? '');
      setFastModel(activeProject.fastModel ?? '');
      setEmbeddingModel(activeProject.embeddingModel ?? '');
      setSmartTiering(activeProject.smartTiering);
      setGenerationMode(activeProject.generationMode);
      setVideoProvider(activeProject.videoProvider);
      setClipDuration(activeProject.defaultClipDuration);
      setConfiguredWpm(activeProject.configuredWpm);
      setTargetDuration(activeProject.targetDuration);
      setMasterPromptText(activeProject.masterPrompt ?? '');
      if (activeProject.masterPromptExtracted) {
        setExtractedSettings(safeExtractedSettings(activeProject.masterPromptExtracted));
      }
    }
  }, [activeProject]);

  React.useEffect(() => {
    if (masterPromptState) {
      setMasterPromptText(masterPromptState.text ?? '');
      if (masterPromptState.extracted) {
        setExtractedSettings(safeExtractedSettings(masterPromptState.extracted));
      }
    }
  }, [masterPromptState]);

  const validGeminiKeys = keys.filter(
    (k) => (k.status === 'VALID' || k.status === 'ACTIVE') && k.keyType !== 'YOUTUBE'
  );
  const hasValidKey = validGeminiKeys.length > 0;

  // Combine discovered models from health + discovery endpoint
  const availableReasoningModels = Array.from(
    new Set([
      ...(discovery?.reasoningModels.map((m) => m.id) ?? []),
      ...(llmHealth?.models.reasoningModels ?? []),
      ...(reasoningModel ? [reasoningModel] : []),
    ])
  );
  const availableFastModels = Array.from(
    new Set([
      ...(discovery?.fastModels.map((m) => m.id) ?? []),
      ...(llmHealth?.models.fastModels ?? []),
      ...(fastModel ? [fastModel] : []),
    ])
  );
  const availableEmbeddingModels = Array.from(
    new Set([
      ...(discovery?.embeddingModels.map((m) => m.id) ?? []),
      ...(llmHealth?.models.embeddingModels ?? []),
      ...(embeddingModel ? [embeddingModel] : []),
    ])
  );

  const handleAddKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rawKey.trim()) return;
    setBusyKey(true);
    try {
      const res = await apiRequest<{
        key: VaultKeyItem;
        valid: boolean;
        message: string;
      }>('/api/v1/vault/keys', {
        method: 'POST',
        body: {
          apiKey: rawKey.trim(),
          projectLabel:
            keyLabel.trim() ||
            (keyType === 'YOUTUBE' ? 'YouTube Data API Key' : 'Primary Studio Key'),
          keyType,
        },
      });
      setRawKey('');
      setKeyLabel('');
      await onRefreshState();
      onNotify(res.message, res.valid ? 'success' : 'warn');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setBusyKey(false);
    }
  };

  const handleTestKeyClick = async (id: number) => {
    setTestingKeyId(id);
    try {
      const res = await apiRequest<{
        key: VaultKeyItem;
        valid: boolean;
        message: string;
      }>(`/api/v1/vault/keys/${id}/test`, { method: 'POST' });
      await onRefreshState();
      onNotify(res.message, res.valid ? 'success' : 'warn');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setTestingKeyId(null);
    }
  };

  const handleRemoveKey = async (id: number) => {
    try {
      await apiRequest(`/api/v1/vault/keys/${id}`, { method: 'DELETE' });
      await onRefreshState();
      onNotify('Key removed from Vault', 'warn');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    }
  };

  const handleDiscoverModels = async () => {
    setDiscovering(true);
    try {
      const data = await apiRequest<ModelDiscoveryData>('/api/v1/vault/models');
      setDiscovery(data);
      if (data.recommendedReasoning && !reasoningModel) {
        setReasoningModel(data.recommendedReasoning);
      }
      if (data.recommendedFast && !fastModel) {
        setFastModel(data.recommendedFast);
      }
      if (data.recommendedEmbedding && !embeddingModel) {
        setEmbeddingModel(data.recommendedEmbedding);
      }
      await onRefreshState();
      onNotify('Live models discovered from Gemini endpoint', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setDiscovering(false);
    }
  };

  const handleSaveEngineConfig = async () => {
    if (!activeProject) {
      onNotify('Create or select a project first', 'warn');
      return;
    }
    setSavingConfig(true);
    try {
      await apiRequest('/api/v1/stage/0/save', {
        method: 'POST',
        body: {
          brandName: brandName.trim() || 'FactLock',
          reasoningModel: reasoningModel || undefined,
          fastModel: fastModel || undefined,
          embeddingModel: embeddingModel || undefined,
          smartTiering,
          generationMode,
          videoProvider,
          defaultClipDuration:
            videoProvider === 'VEO_3_1' ? VEO_3_1_FIXED_DURATION : clipDuration,
          configuredWpm,
          targetDuration,
        },
      });
      await onRefreshState();
      onNotify('Vault & model routing settings saved', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setSavingConfig(false);
    }
  };

  const handleAnalyseAndSaveMasterPrompt = async (skipLlmExtraction = false) => {
    if (!activeProject) {
      onNotify('Create or select a project first', 'warn');
      return;
    }
    setAnalysingMasterPrompt(true);
    try {
      const res = await apiRequest<{
        masterPrompt?: MasterPromptState;
        extracted?: MasterPromptExtraction;
        isUniversalMode?: boolean;
        extractionError?: string | null;
      }>('/api/v1/stage/0/master-prompt', {
        method: 'PUT',
        body: {
          text: masterPromptText,
          extractedOverride: skipLlmExtraction ? extractedSettings : undefined,
          skipLlmExtraction,
        },
      });
      const resolvedMasterPrompt = res.masterPrompt ?? (res as unknown as MasterPromptState);
      const extractedObj = safeExtractedSettings(
        resolvedMasterPrompt?.extracted ?? res.extracted
      );
      setExtractedSettings(extractedObj);
      await onRefreshState();
      const isUniversal = resolvedMasterPrompt?.isUniversalMode ?? res.isUniversalMode;
      const extractionErr = resolvedMasterPrompt?.extractionError ?? res.extractionError;
      if (extractionErr) {
        onNotify(`Master prompt text saved (${extractionErr})`, 'warn');
      } else {
        onNotify(
          isUniversal
            ? `Reset to ${UNIVERSAL_CREATOR_MODE_LABEL}`
            : 'Master Prompt analysed & locked',
          'success'
        );
      }
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    } finally {
      setAnalysingMasterPrompt(false);
    }
  };

  const handleUnlockDna = async () => {
    if (!activeProject) return;
    try {
      await apiRequest('/api/v1/stage/0/dna/unlock', { method: 'POST' });
      await onRefreshState();
      onNotify('Channel DNA unlocked (downstream stages marked DIRTY)', 'warn');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    }
  };

  const handleAddQuickBlacklist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!blacklistInput.trim() || !activeProject) return;
    try {
      await apiRequest('/api/v1/blacklist', {
        method: 'POST',
        body: {
          topicTitle: blacklistInput.trim(),
          bannedAnchor: blacklistInput.trim(),
        },
      });
      setBlacklistInput('');
      onNotify('Topic added to Blacklist', 'warn');
    } catch (err) {
      onNotify((err as Error).message, 'error', err);
    }
  };

  const getStatusBadge = (status: VaultKeyItem['status']) => {
    if (status === 'VALID' || status === 'ACTIVE') {
      return (
        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          VALID
        </span>
      );
    }
    if (status === 'COOLDOWN_429' || status === 'QUOTA_EXCEEDED') {
      return (
        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
          {status}
        </span>
      );
    }
    return (
      <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-rose-500/15 text-rose-400 border border-rose-500/30">
        {status}
      </span>
    );
  };

  const healthColor =
    hasValidKey && availableReasoningModels.length > 0
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : keys.length > 0
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : 'bg-rose-500/15 text-rose-300 border-rose-500/30';

  return (
    <div className="space-y-5 pb-28">
      {/* 1. API Keys & Live Validation (Part A1) */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-white">
                1. API Keys & Live Health
              </h2>
              <p className="text-xs text-slate-400">
                AES-256-GCM Vault • Live Probe Verification
              </p>
            </div>
          </div>
          <span
            data-testid="llm-health-pill"
            className={`font-mono text-[11px] px-2.5 py-1 rounded-xl border ${healthColor}`}
          >
            {hasValidKey
              ? `LLM Ready (${validGeminiKeys.length} VALID)`
              : keys.length > 0
                ? 'Needs Valid Key'
                : 'No Key'}
          </span>
        </div>

        <div className="space-y-2.5">
          {keys.length === 0 ? (
            <div className="liquid-glass-subtle p-4 text-center text-xs text-slate-400">
              No keys stored yet. Add at least one Gemini key below to unlock pipeline stages.
            </div>
          ) : (
            keys.map((k) => {
              const totalDiscovered =
                (k.discoveredModels?.reasoningModels?.length ?? 0) +
                (k.discoveredModels?.fastModels?.length ?? 0) +
                (k.discoveredModels?.embeddingModels?.length ?? 0);
              return (
                <div
                  key={k.id}
                  className="liquid-glass-subtle px-3.5 py-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-slate-100 truncate">
                          {k.projectLabel}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-slate-300">
                          {k.keyType}
                        </span>
                        {getStatusBadge(k.status)}
                      </div>
                      <p className="font-mono text-xs text-slate-400 mt-0.5">{k.maskedKey}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleTestKeyClick(k.id)}
                        disabled={testingKeyId === k.id}
                        className="px-2.5 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1 active:scale-[0.97]"
                      >
                        <FlaskConical className="w-3.5 h-3.5" />
                        {testingKeyId === k.id ? 'Testing...' : 'Test'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveKey(k.id)}
                        aria-label={`Remove ${k.projectLabel}`}
                        className="p-2 rounded-xl text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors active:scale-[0.97]"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {totalDiscovered > 0 && (
                    <p className="text-[11px] text-emerald-300/90 font-mono">
                      Discovered: {k.discoveredModels.reasoningModels.length} reasoning,{' '}
                      {k.discoveredModels.fastModels.length} fast,{' '}
                      {k.discoveredModels.embeddingModels.length} embedding
                    </p>
                  )}
                  {k.lastError && (
                    <p className="text-[11px] text-rose-300 bg-rose-950/50 px-2.5 py-1 rounded-lg border border-rose-500/30">
                      {k.lastError}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>

        <form onSubmit={handleAddKeySubmit} className="space-y-2.5 pt-1">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select
              value={keyType}
              onChange={(e) => setKeyType(e.target.value as 'GEMINI' | 'YOUTUBE')}
              aria-label="Key Type"
              className="px-3 py-2.5 rounded-2xl bg-slate-900/70 border border-white/10 text-xs text-white"
            >
              <option value="GEMINI">Gemini API Key</option>
              <option value="YOUTUBE">YouTube Data v3 Key (Optional)</option>
            </select>
            <input
              type="text"
              value={keyLabel}
              onChange={(e) => setKeyLabel(e.target.value)}
              placeholder="Key Label (e.g. Studio Key #1)"
              className="px-3.5 py-2.5 rounded-2xl bg-slate-900/70 border border-white/10 text-xs text-white placeholder-slate-500"
            />
            <input
              type="password"
              value={rawKey}
              onChange={(e) => setRawKey(e.target.value)}
              placeholder="Paste API Key..."
              className="px-3.5 py-2.5 rounded-2xl bg-slate-900/70 border border-white/10 font-mono text-xs text-white placeholder-slate-500"
            />
          </div>
          <button
            type="submit"
            disabled={busyKey || !rawKey.trim()}
            className="w-full py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 transition-all active:scale-[0.97]"
          >
            <Plus className="w-4 h-4" />
            {busyKey ? 'Validating & Encrypting Key...' : 'Validate & Add Key to Pool'}
          </button>
        </form>
      </section>

      {/* 2. Model Tier Selection & Smart Tiering (Part A1 & C10) */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-violet-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-white">
                2. Model Tier Selection
              </h2>
              <p className="text-xs text-slate-400">
                Discovered Reasoning, Fast & Embedding Models Only
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDiscoverModels}
            disabled={discovering || !hasValidKey}
            className="px-3 py-2 rounded-xl bg-violet-500/15 hover:bg-violet-500/25 disabled:opacity-40 text-violet-300 border border-violet-500/30 text-xs font-medium flex items-center gap-1.5 transition-all active:scale-[0.97]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${discovering ? 'animate-spin' : ''}`} />
            {discovering ? 'Scanning...' : 'Sync Models'}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">
              Reasoning Tier
            </label>
            <select
              aria-label="Reasoning Model"
              value={reasoningModel}
              onChange={(e) => setReasoningModel(e.target.value)}
              className="w-full px-3 py-2.5 rounded-2xl bg-slate-900/80 border border-white/10 text-xs text-white font-mono"
            >
              <option value="">-- Select Reasoning Model --</option>
              {availableReasoningModels.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">
              Fast Tier
            </label>
            <select
              aria-label="Fast Model"
              value={fastModel}
              onChange={(e) => setFastModel(e.target.value)}
              className="w-full px-3 py-2.5 rounded-2xl bg-slate-900/80 border border-white/10 text-xs text-white font-mono"
            >
              <option value="">-- Select Fast Model --</option>
              {availableFastModels.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">
              Embedding Tier (EMRI)
            </label>
            <select
              aria-label="Embedding Model"
              value={embeddingModel}
              onChange={(e) => setEmbeddingModel(e.target.value)}
              className="w-full px-3 py-2.5 rounded-2xl bg-slate-900/80 border border-white/10 text-xs text-white font-mono"
            >
              <option value="">-- Select Embedding Model --</option>
              {availableEmbeddingModels.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="liquid-glass-subtle p-3.5 flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-white">Smart Tiering</span>
            <p className="text-[11px] text-slate-400">
              Fast Tier for Ideation & Checks, Reasoning Tier for Research & Script
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSmartTiering((v) => !v)}
            className={`w-12 h-7 rounded-full transition-colors p-1 ${
              smartTiering ? 'bg-emerald-500' : 'bg-slate-700'
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full bg-slate-950 transition-transform ${
                smartTiering ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </section>

      {/* 3. Channel DNA & Style Lock Card (Part C & C10) */}
      <section className="liquid-glass p-5 space-y-4 border-emerald-500/30">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Dna className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-white">
                3. Channel DNA & Style Lock (S0B)
              </h2>
              <p className="text-xs text-slate-400">
                Required before Stage 1 • Drives Language, Pacing & Visuals
              </p>
            </div>
          </div>
          {channelDna ? (
            <span className="px-2.5 py-1 rounded-xl bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono text-xs">
              LOCKED v{channelDna.version}
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded-xl bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono text-xs">
              UNLOCKED
            </span>
          )}
        </div>

        {channelDna ? (
          <div className="liquid-glass-subtle p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-bold text-white">
                {channelDna.identity?.niche ?? (channelDna as any)?.dna?.identity?.niche ?? 'Custom Channel'}
              </span>
              <span className="font-mono text-emerald-300">
                {channelDna.source ?? (channelDna as any)?.dna?.source ?? 'NICHE'} • Fidelity {channelDna.fidelity ?? (channelDna as any)?.dna?.fidelity ?? 70}/100
              </span>
            </div>
            <div className="text-[11px] text-slate-300">
              Language: <strong className="text-white">
                {channelDna.language?.primary ?? (channelDna as any)?.dna?.language?.primary ?? 'en'}
              </strong> (
              {channelDna.language?.script ?? (channelDna as any)?.dna?.language?.script ?? 'Latin'}) • WPM:{' '}
              <strong className="text-white">
                {channelDna.pacingAndMetrics?.wpm ?? (channelDna as any)?.voice?.wpm ?? (channelDna as any)?.dna?.voice?.wpm ?? 187.41}
              </strong> •
              Sentences:{' '}
              <strong className="text-white">
                {channelDna.pacingAndMetrics?.sentenceLengthMin ?? (channelDna as any)?.voice?.sentenceLen?.[0] ?? (channelDna as any)?.dna?.voice?.sentenceLen?.[0] ?? 14}–
                {channelDna.pacingAndMetrics?.sentenceLengthMax ?? (channelDna as any)?.voice?.sentenceLen?.[1] ?? (channelDna as any)?.dna?.voice?.sentenceLen?.[1] ?? 22}w
              </strong>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowDnaWizard(true)}
                className="px-3 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold"
              >
                Edit DNA / Re-analyse
              </button>
              <button
                type="button"
                onClick={handleUnlockDna}
                className="px-3 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 text-xs font-semibold flex items-center gap-1"
              >
                <Unlock className="w-3.5 h-3.5" />
                Unlock
              </button>
            </div>
          </div>
        ) : (
          <div className="liquid-glass-subtle p-4 space-y-3">
            <p className="text-xs text-slate-300">
              No Channel DNA is locked yet. Configure your channel profile from an existing
              YouTube channel, a new niche, or 1–3 reference channels to unlock Stage 1.
            </p>
            <button
              type="button"
              disabled={!activeProject}
              onClick={() => setShowDnaWizard(true)}
              className="w-full py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5"
            >
              <Dna className="w-4 h-4" />
              Open Channel DNA & Style Lock Wizard
            </button>
          </div>
        )}
      </section>

      {/* 4. Master Prompt Override Card (Part B & C10) */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-white">
                4. Master Prompt Override (Stage 0)
              </h2>
              <p className="text-xs text-slate-400">
                Custom Persona, Chapter Overrides, Negative Prompts & Banned Words
              </p>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[10px] font-mono">
            {!masterPromptText.trim()
              ? UNIVERSAL_CREATOR_MODE_LABEL
              : 'Custom Override Active'}
          </span>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>Master System Override Text</span>
            <div className="flex items-center gap-2">
              <span className="font-mono">{masterPromptText.length} chars</span>
              {masterPromptText && (
                <button
                  type="button"
                  onClick={() => setMasterPromptText('')}
                  className="text-rose-400 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <textarea
            rows={8}
            value={masterPromptText}
            onChange={(e) => setMasterPromptText(e.target.value)}
            placeholder="Paste optional Master Prompt Override here (persona, custom chapters, brand name, negative prompts, tone words, banned words). Leave empty for Universal Any-Niche Creator Mode."
            className="w-full p-3.5 rounded-2xl bg-slate-900/80 border border-white/10 text-xs text-white leading-relaxed"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            disabled={analysingMasterPrompt || !activeProject}
            onClick={() => handleAnalyseAndSaveMasterPrompt(false)}
            className="flex-1 py-2.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-40 text-cyan-200 border border-cyan-500/30 text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {analysingMasterPrompt ? 'Analysing Prompt...' : 'Analyse Prompt & Save'}
          </button>
          <button
            type="button"
            disabled={analysingMasterPrompt || !activeProject}
            onClick={() => handleAnalyseAndSaveMasterPrompt(true)}
            className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-semibold"
          >
            Save Edited Fields
          </button>
        </div>

        {/* Editable Extracted Settings Preview */}
        <div className="liquid-glass-subtle p-3.5 space-y-2.5">
          <div className="text-xs font-semibold text-white">
            Extracted Settings Preview (Editable)
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">Persona</label>
              <input
                type="text"
                value={extractedSettings?.persona ?? ''}
                onChange={(e) =>
                  setExtractedSettings((prev) => ({
                    ...safeExtractedSettings(prev),
                    persona: e.target.value,
                  }))
                }
                placeholder="Extracted persona..."
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-white/10 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">Brand Name</label>
              <input
                type="text"
                value={extractedSettings?.brandName ?? ''}
                onChange={(e) =>
                  setExtractedSettings((prev) => ({
                    ...safeExtractedSettings(prev),
                    brandName: e.target.value,
                  }))
                }
                placeholder="Brand override..."
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-white/10 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">
                Custom Chapters (comma separated)
              </label>
              <input
                type="text"
                value={(extractedSettings?.customChapters ?? []).join(', ')}
                onChange={(e) =>
                  setExtractedSettings((prev) => ({
                    ...safeExtractedSettings(prev),
                    customChapters: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }))
                }
                placeholder="Hook, Deep Dive, Payoff..."
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-white/10 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">
                Banned Words (comma separated, C05)
              </label>
              <input
                type="text"
                value={(extractedSettings?.bannedWords ?? []).join(', ')}
                onChange={(e) =>
                  setExtractedSettings((prev) => ({
                    ...safeExtractedSettings(prev),
                    bannedWords: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }))
                }
                placeholder="synergy, delve..."
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-white/10 text-xs text-white"
              />
            </div>
          </div>
        </div>
      </section>

      {/* 5. Brand, Pacing & Generation Mode Calibration */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <Film className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-tight text-white">
              5. Brand, Pacing & Visual Engine
            </h2>
            <p className="text-xs text-slate-400">Model-Locked Slot Calibration</p>
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-slate-400 mb-1 flex items-center gap-1">
            <BadgeCheck className="w-3.5 h-3.5 text-emerald-400" />
            Channel Brand Lock (Final Payoff Only)
          </label>
          <input
            type="text"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            placeholder="FactLock"
            className="w-full px-3.5 py-2.5 rounded-2xl bg-slate-900/80 border border-white/10 text-xs text-white"
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { id: 'MODE_1_IMAGE', title: 'Mode 1', desc: 'Keyframe 1–2.8s' },
              { id: 'MODE_2_VIDEO', title: 'Mode 2', desc: 'Image → Video' },
              { id: 'MODE_3_DIRECT_VIDEO', title: 'Mode 3', desc: 'Direct Video' },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setGenerationMode(m.id)}
              className={`p-3 rounded-2xl text-left border transition-all active:scale-[0.97] ${
                generationMode === m.id
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-slate-900/60 border-white/10 text-slate-400'
              }`}
            >
              <div className="text-xs font-semibold text-white">{m.title}</div>
              <div className="text-[10px] mt-0.5">{m.desc}</div>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => {
              setVideoProvider('VEO_3_1');
              setClipDuration(VEO_3_1_FIXED_DURATION);
            }}
            className={`p-3 rounded-2xl border text-left transition-all active:scale-[0.97] ${
              videoProvider === 'VEO_3_1'
                ? 'bg-violet-500/15 border-violet-500/40 text-violet-200'
                : 'bg-slate-900/60 border-white/10 text-slate-400'
            }`}
          >
            <div className="text-xs font-semibold text-white">Veo 3.1 Engine</div>
            <div className="text-[11px] font-mono mt-0.5">Fixed 8.0s (4.5–7.8s)</div>
          </button>

          <button
            type="button"
            onClick={() => setVideoProvider('OMNI_FLASH')}
            className={`p-3 rounded-2xl border text-left transition-all active:scale-[0.97] ${
              videoProvider === 'OMNI_FLASH'
                ? 'bg-violet-500/15 border-violet-500/40 text-violet-200'
                : 'bg-slate-900/60 border-white/10 text-slate-400'
            }`}
          >
            <div className="text-xs font-semibold text-white">Omni Flash 1.1</div>
            <div className="text-[11px] font-mono mt-0.5">4s / 6s / 8s / 10s</div>
          </button>
        </div>

        {videoProvider === 'OMNI_FLASH' && (
          <div className="flex items-center gap-2">
            {OMNI_FLASH_DURATIONS.map((dur) => (
              <button
                key={dur}
                type="button"
                onClick={() => setClipDuration(dur)}
                className={`flex-1 py-2 rounded-xl font-mono text-xs border transition-all active:scale-[0.97] ${
                  clipDuration === dur
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                    : 'bg-slate-900/60 border-white/10 text-slate-400'
                }`}
              >
                {dur}s
              </button>
            ))}
          </div>
        )}

        <div className="space-y-3 pt-1">
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-400 flex items-center gap-1">
                <Gauge className="w-3.5 h-3.5 text-emerald-400" />
                Target Duration
              </span>
              <span className="font-mono text-white font-semibold">
                {targetDuration} min ({Math.round(targetDuration * configuredWpm)} words)
              </span>
            </div>
            <input
              type="range"
              min={4}
              max={22}
              step={1}
              value={targetDuration}
              onChange={(e) => setTargetDuration(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-400 flex items-center gap-1">
                <Sliders className="w-3.5 h-3.5 text-violet-400" />
                Speaking Pace (WPM)
              </span>
              <span className="font-mono text-white font-semibold">
                {configuredWpm.toFixed(2)} WPM
              </span>
            </div>
            <input
              type="range"
              min={WPM_MIN}
              max={WPM_MAX}
              step={0.5}
              value={configuredWpm}
              onChange={(e) => setConfiguredWpm(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={handleSaveEngineConfig}
          disabled={savingConfig || !activeProject}
          className="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 transition-all active:scale-[0.97]"
        >
          <CheckCircle2 className="w-4 h-4" />
          {savingConfig ? 'Saving Calibration...' : 'Lock Vault Configuration'}
        </button>

        {!activeProject && (
          <div className="flex items-center gap-2 text-amber-400 text-xs bg-amber-500/10 p-3 rounded-xl border border-amber-500/20">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Create a project in the top bar to save project-specific calibration.</span>
          </div>
        )}
      </section>

      {/* 6. Blacklist Quick Entry (C10) */}
      <section className="liquid-glass p-5 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldBan className="w-4 h-4 text-rose-400" />
          <h3 className="text-sm font-semibold text-white">6. Topic Blacklist & Banned Anchors</h3>
        </div>
        <form onSubmit={handleAddQuickBlacklist} className="flex gap-2">
          <input
            type="text"
            value={blacklistInput}
            onChange={(e) => setBlacklistInput(e.target.value)}
            placeholder="Add topic or anchor to exclude from Stage 1..."
            className="flex-1 px-3.5 py-2 rounded-xl bg-slate-900/80 border border-white/10 text-xs text-white"
          />
          <button
            type="submit"
            disabled={!activeProject || !blacklistInput.trim()}
            className="px-4 py-2 rounded-xl bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-semibold disabled:opacity-40"
          >
            Add
          </button>
        </form>
      </section>

      {/* 7. System & Runtime Diagnostics (P3.6) */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-sky-400" />
            <h3 className="text-sm font-semibold text-white">7. System & Runtime Diagnostics</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleFetchDiagnostics}
              disabled={loadingDiagnostics}
              className="px-3 py-1.5 rounded-xl bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-semibold flex items-center gap-1.5 active:scale-[0.97]"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingDiagnostics ? 'animate-spin' : ''}`} />
              {loadingDiagnostics ? 'Inspecting...' : diagnostics ? 'Refresh' : 'Run Diagnostics'}
            </button>
            {diagnostics && (
              <button
                type="button"
                onClick={handleCopyDiagnostics}
                className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-200 border border-white/10 text-xs font-semibold flex items-center gap-1.5 active:scale-[0.97]"
              >
                {copiedDiag ? <ClipboardCheck className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedDiag ? 'Copied' : 'Copy All'}
              </button>
            )}
          </div>
        </div>

        {diagnostics && (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="p-2.5 rounded-xl bg-slate-900/80 border border-white/8">
                <div className="text-[10px] text-slate-400">Runtime / Bind</div>
                <div className="font-mono text-white truncate">{diagnostics.runtimeMode} • {diagnostics.bindAddress}:{diagnostics.port}</div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900/80 border border-white/8">
                <div className="text-[10px] text-slate-400">Gemini Keys</div>
                <div className="font-mono text-emerald-400">{diagnostics.geminiKeys.valid} valid / {diagnostics.geminiKeys.total} total</div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900/80 border border-white/8">
                <div className="text-[10px] text-slate-400">YouTube Key</div>
                <div className={`font-mono ${diagnostics.youtubeKey.valid ? 'text-emerald-400' : 'text-slate-400'}`}>
                  {diagnostics.youtubeKey.status}
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900/80 border border-white/8">
                <div className="text-[10px] text-slate-400">Database (WAL)</div>
                <div className="font-mono text-white">{(diagnostics.database.totalSizeBytes / 1024).toFixed(1)} KB</div>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-900/70 border border-white/8 text-xs space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Node: {diagnostics.nodeVersion} ({diagnostics.platform}_{diagnostics.arch})</span>
                <span>Uptime: {Math.floor(diagnostics.uptimeSec / 60)}m {diagnostics.uptimeSec % 60}s</span>
                <span>Heap: {(diagnostics.memoryUsage.heapUsed / 1024 / 1024).toFixed(1)} MB</span>
              </div>
              <div className="text-[11px] text-slate-300">
                <span className="font-semibold text-slate-400 mr-1">Discovered Models:</span>
                Reasoning: {diagnostics.discoveredModels.reasoningModels.join(', ') || 'None'} | Fast: {diagnostics.discoveredModels.fastModels.join(', ') || 'None'}
              </div>
            </div>

            {diagnostics.lastLogs.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
                  <Terminal className="w-3.5 h-3.5 text-slate-400" />
                  <span>Last LLM Calls (server.log redacted)</span>
                </div>
                <div className="p-2.5 rounded-xl bg-black/80 border border-white/10 font-mono text-[10px] text-slate-300 max-h-40 overflow-y-auto space-y-1">
                  {diagnostics.lastLogs.map((line, idx) => (
                    <div key={idx} className="truncate">{line}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {showDnaWizard && activeProject && (
        <ChannelDnaWizard
          activeProject={activeProject}
          initialDna={channelDna}
          hasValidKey={hasValidKey}
          onClose={() => setShowDnaWizard(false)}
          onLocked={async () => {
            await onRefreshState();
          }}
          onJumpToExpress={() => onNavigateHub?.('script')}
          onNotify={onNotify}
        />
      )}
    </div>
  );
};
