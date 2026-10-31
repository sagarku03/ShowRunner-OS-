/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  FolderPlus,
  Key,
  AlertOctagon,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { BottomNav } from './components/BottomNav.tsx';
import { ExportHub } from './components/ExportHub.tsx';
import { ScriptHub } from './components/ScriptHub.tsx';
import { StudioHub } from './components/StudioHub.tsx';
import { TopicsHub } from './components/TopicsHub.tsx';
import { VaultHub } from './components/VaultHub.tsx';
import type {
  ChannelDnaRecord,
  HubId,
  LlmHealthData,
  MasterPromptState,
  PipelineStateVector,
  ProjectItem,
  VaultKeyItem,
} from './types/showrunner.ts';
import {
  ApiClientError,
  apiRequest,
  getStoredBearerToken,
  getStoredProjectId,
  loadCachedSnapshot,
  saveCachedSnapshot,
  setStoredBearerToken,
  setStoredProjectId,
  type CachedPipelineSnapshot,
} from './utils/apiClient.ts';

export default function App() {
  const [activeHub, setActiveHub] = useState<HubId>('vault');
  const [mode, setMode] = useState<'termux' | 'preview'>('preview');
  const [showPreviewBanner, setShowPreviewBanner] = useState(false);

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectItem | null>(null);
  const [stateVector, setStateVector] = useState<PipelineStateVector | null>(null);
  const [channelDna, setChannelDna] = useState<ChannelDnaRecord | null>(null);
  const [masterPromptState, setMasterPromptState] = useState<MasterPromptState | null>(null);
  const [llmHealth, setLlmHealth] = useState<LlmHealthData | null>(null);
  const [keys, setKeys] = useState<VaultKeyItem[]>([]);

  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [newProjNiche, setNewProjNiche] = useState('');
  const [newProjDuration, setNewProjDuration] = useState(10);
  const [newProjEntryMode, setNewProjEntryMode] = useState<'FULL' | 'EXPRESS'>('FULL');
  const [creatingProject, setCreatingProject] = useState(false);

  const [needsTokenModal, setNeedsTokenModal] = useState(false);
  const [tokenInput, setTokenInput] = useState(getStoredBearerToken());

  const [wsConnected, setWsConnected] = useState(false);
  const [activeJobProgress, setActiveJobProgress] = useState<{
    jobId: string;
    stageId: string;
    progressPct: number;
    phase: string;
  } | null>(null);

  const [toast, setToast] = useState<{
    message: string;
    tone: 'success' | 'warn' | 'error';
    code?: string;
    raw?: string;
    retryable?: boolean;
  } | null>(null);
  const [showToastDetails, setShowToastDetails] = useState(false);

  const notify = useCallback(
    (
      message: string,
      tone: 'success' | 'warn' | 'error' = 'success',
      err?: unknown
    ) => {
      setShowToastDetails(false);
      if (err instanceof ApiClientError) {
        setToast({
          message: err.userMessage || message,
          tone,
          code: err.code,
          raw: err.raw,
          retryable: err.retryable,
        });
      } else {
        setToast({ message, tone });
      }
    },
    []
  );

  useEffect(() => {
    if (!toast || toast.tone === 'error') return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshPipelineState = useCallback(async (explicitProjectId?: string) => {
    try {
      const pid = explicitProjectId ?? getStoredProjectId();
      const query = pid ? `?projectId=${encodeURIComponent(pid)}` : '';
      const data = await apiRequest<CachedPipelineSnapshot>(
        `/api/v1/pipeline/state${query}`,
        { projectId: pid || undefined }
      );

      setMode(data.mode);
      setShowPreviewBanner(data.showPreviewBanner);
      setProjects(data.projects);
      setActiveProject(data.activeProject);
      setStateVector(data.stateVector);
      setChannelDna(data.channelDna ?? null);
      setMasterPromptState(data.masterPromptState ?? null);
      setLlmHealth(data.llmHealth ?? null);
      setKeys(data.keys);
      setNeedsTokenModal(false);

      if (data.activeProject) {
        setStoredProjectId(data.activeProject.id);
      }

      void saveCachedSnapshot(data);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        setNeedsTokenModal(true);
      }
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadCachedSnapshot().then((cached) => {
      if (mounted && cached) {
        setMode(cached.mode);
        setShowPreviewBanner(cached.showPreviewBanner);
        setProjects(cached.projects);
        setActiveProject(cached.activeProject);
        setStateVector(cached.stateVector);
        setChannelDna(cached.channelDna ?? null);
        setMasterPromptState(cached.masterPromptState ?? null);
        setLlmHealth(cached.llmHealth ?? null);
        setKeys(cached.keys);
      }
      if (mounted) {
        void refreshPipelineState();
      }
    });
    return () => {
      mounted = false;
    };
  }, [refreshPipelineState]);

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getStoredBearerToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${proto}//${window.location.host}/ws/ipc${qs}`;

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => setWsConnected(false);
      ws.onerror = () => setWsConnected(false);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type?: string;
            payload?: Record<string, unknown>;
          };
          if (msg.type === 'PING' && ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'PONG' }));
            return;
          }
          if (msg.type === 'KEY_FAILOVER') {
            const p = msg.payload ?? {};
            notify(
              `Key Failover: Switched from ${String(p.fromKeyLabel ?? 'Key')} to ${String(
                p.toKeyLabel ?? 'Backup Key'
              )}`,
              'warn'
            );
            void refreshPipelineState();
          } else if (msg.type === 'JOB_PROGRESS') {
            const p = msg.payload ?? {};
            setActiveJobProgress({
              jobId: String(p.jobId ?? ''),
              stageId: String(p.stageId ?? ''),
              progressPct: Number(p.progressPct ?? 25),
              phase: String(p.phase ?? 'RUNNING'),
            });
          } else if (msg.type === 'JOB_DONE') {
            setActiveJobProgress(null);
            void refreshPipelineState();
          } else if (msg.type === 'JOB_ERROR') {
            setActiveJobProgress(null);
            void refreshPipelineState();
          } else if (msg.type === 'GATE_RESULT') {
            void refreshPipelineState();
          }
        } catch {
          // Ignore malformed WS message
        }
      };
    } catch {
      setWsConnected(false);
    }

    return () => {
      ws?.close();
    };
  }, [notify, refreshPipelineState]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjName.trim() || !newProjNiche.trim()) return;
    setCreatingProject(true);
    try {
      const res = await apiRequest<{
        project: ProjectItem;
        stateVector: PipelineStateVector;
      }>('/api/v1/projects', {
        method: 'POST',
        body: {
          name: newProjName.trim(),
          niche: newProjNiche.trim(),
          targetDuration: newProjDuration,
          entryMode: newProjEntryMode,
        },
      });
      setStoredProjectId(res.project.id);
      setNewProjName('');
      setNewProjNiche('');
      setShowNewProjectModal(false);
      await refreshPipelineState(res.project.id);
      if (newProjEntryMode === 'EXPRESS') {
        setActiveHub('script');
        notify(`Created Express project "${res.project.name}" (direct transcript mode)`, 'success');
      } else {
        notify(`Created project "${res.project.name}"`, 'success');
      }
    } catch (err) {
      notify((err as Error).message, 'error', err);
    } finally {
      setCreatingProject(false);
    }
  };

  const handleSwitchProject = async (projectId: string) => {
    setStoredProjectId(projectId);
    await refreshPipelineState(projectId);
  };

  const handleSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setStoredBearerToken(tokenInput.trim());
    await refreshPipelineState();
  };

  const hasValidKey = keys.some(
    (k) => (k.status === 'VALID' || k.status === 'ACTIVE') && k.keyType !== 'YOUTUBE'
  );
  const hasSelectedModel = Boolean(
    activeProject?.reasoningModel || activeProject?.fastModel
  );
  const llmDisabledReason = !hasValidKey
    ? 'No VALID Gemini API key in Vault. Open Vault → Validate & Add Key.'
    : !hasSelectedModel
      ? 'No usable model selected. Open Vault → Test key → pick a model.'
      : null;

  return (
    <div className="min-h-screen bg-[#07080B] text-slate-100 relative overflow-x-hidden selection:bg-emerald-500/30">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed -top-32 -left-24 w-96 h-96 rounded-full bg-cyan-500/10 blur-[110px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed top-1/3 -right-28 w-96 h-96 rounded-full bg-violet-600/12 blur-[120px]"
      />

      {showPreviewBanner && (
        <div
          role="status"
          className="bg-rose-950/90 border-b border-rose-500/40 px-4 py-2 text-center text-[11px] font-medium text-rose-200"
        >
          PREVIEW MODE — not secured. Never deploy publicly. Use Termux mode for real use.
        </div>
      )}

      <header className="sticky top-0 z-40 backdrop-blur-2xl bg-[#07080B]/80 border-b border-white/8 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-400 to-violet-500 flex items-center justify-center text-slate-950 font-bold text-xs shadow-lg shadow-emerald-500/20">
              SR
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="text-sm font-bold tracking-tight text-white truncate">
                  ShowRunner OS
                </h1>
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-white/10 text-emerald-400">
                  v1.3
                </span>
              </div>
              <p className="text-[11px] text-slate-400 truncate">
                {activeProject
                  ? `${activeProject.name} • ${activeProject.activeState}`
                  : 'No Project Selected'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {projects.length > 0 && (
              <select
                aria-label="Select Project"
                value={activeProject?.id ?? ''}
                onChange={(e) => handleSwitchProject(e.target.value)}
                className="max-w-[130px] px-2.5 py-1.5 rounded-xl bg-slate-900/90 border border-white/10 text-xs text-white truncate"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => setShowNewProjectModal(true)}
              className="px-2.5 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1 active:scale-[0.97]"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>New</span>
            </button>
          </div>
        </div>
      </header>

      {activeJobProgress && (
        <div className="max-w-lg mx-auto px-4 pt-2">
          <div className="px-3.5 py-2 rounded-xl bg-emerald-950/80 border border-emerald-500/40 text-xs text-emerald-200 flex items-center justify-between">
            <span>
              Running {activeJobProgress.stageId}: {activeJobProgress.phase}
            </span>
            <span className="font-mono">{activeJobProgress.progressPct}%</span>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-32px)] max-w-md">
          <div
            className={`px-4 py-3 rounded-2xl border backdrop-blur-2xl shadow-2xl space-y-2 text-xs font-medium ${
              toast.tone === 'error'
                ? 'bg-rose-950/95 border-rose-500/50 text-rose-200'
                : toast.tone === 'warn'
                  ? 'bg-amber-950/95 border-amber-500/50 text-amber-200'
                  : 'bg-emerald-950/95 border-emerald-500/50 text-emerald-200'
            }`}
          >
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 min-w-0">
                {toast.tone === 'error' ? (
                  <AlertOctagon className="w-4 h-4 text-rose-400 shrink-0" />
                ) : toast.tone === 'warn' ? (
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                )}
                <span className="leading-snug">{toast.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setToast(null)}
                className="text-[10px] px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 shrink-0"
              >
                Dismiss
              </button>
            </div>

            {(toast.raw || toast.code) && (
              <div className="pt-1 border-t border-white/10">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setShowToastDetails((v) => !v)}
                    className="text-[11px] text-rose-300 hover:underline flex items-center gap-1"
                  >
                    <span>Technical details ({toast.code})</span>
                    {showToastDetails ? (
                      <ChevronUp className="w-3 h-3" />
                    ) : (
                      <ChevronDown className="w-3 h-3" />
                    )}
                  </button>
                  {toast.retryable && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-200">
                      Retryable
                    </span>
                  )}
                </div>
                {showToastDetails && (
                  <pre className="mt-1.5 p-2 rounded-lg bg-black/50 text-[10px] font-mono text-rose-200 whitespace-pre-wrap break-all">
                    {toast.raw || toast.code}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <main className="max-w-lg mx-auto px-4 pt-4">
        {!activeProject && (
          <div className="liquid-glass p-5 mb-5 space-y-3 border-emerald-500/30">
            <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold">
              <Sparkles className="w-4 h-4" />
              <span>Welcome to ShowRunner OS v1.3</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Create your first production project to initialize the SQLite state machine,
              Channel DNA Style Lock, WPM word-budget engine, and 17-point verification
              pipeline.
            </p>
            <button
              type="button"
              onClick={() => setShowNewProjectModal(true)}
              className="w-full py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 active:scale-[0.97]"
            >
              <FolderPlus className="w-4 h-4" />
              Create First Project
            </button>
          </div>
        )}

        {activeHub !== 'vault' && llmDisabledReason && (
          <div className="liquid-glass p-3.5 mb-4 border-amber-500/40 bg-amber-500/10 flex items-center justify-between gap-2 text-xs text-amber-200">
            <span>{llmDisabledReason}</span>
            <button
              type="button"
              onClick={() => setActiveHub('vault')}
              className="px-2.5 py-1 rounded-lg bg-amber-500 text-slate-950 font-semibold shrink-0"
            >
              Open Vault
            </button>
          </div>
        )}

        {activeProject?.activeState === 'S_error' && (
          <div className="liquid-glass p-4 mb-4 border-rose-500/40 bg-rose-500/10 flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="text-xs font-semibold text-rose-300 flex items-center gap-1.5">
                <AlertOctagon className="w-4 h-4" />
                <span>Stage Paused on Gate / Error</span>
              </div>
              <p className="text-[11px] text-slate-300">
                Inspect the active stage below and tap Retry after resolving the issue.
              </p>
            </div>
          </div>
        )}

        {activeHub === 'vault' && (
          <VaultHub
            keys={keys}
            activeProject={activeProject}
            channelDna={channelDna}
            masterPromptState={masterPromptState}
            llmHealth={llmHealth}
            onRefreshState={() => refreshPipelineState()}
            onNotify={notify}
          />
        )}
        {activeHub === 'topics' && (
          <TopicsHub
            activeProject={activeProject}
            stateVector={stateVector}
            onRefreshState={() => refreshPipelineState()}
            onNotify={notify}
          />
        )}
        {activeHub === 'studio' && (
          <StudioHub
            activeProject={activeProject}
            stateVector={stateVector}
            onRefreshState={() => refreshPipelineState()}
            onNotify={notify}
          />
        )}
        {activeHub === 'script' && (
          <ScriptHub
            activeProject={activeProject}
            stateVector={stateVector}
            onRefreshState={() => refreshPipelineState()}
            onNotify={notify}
          />
        )}
        {activeHub === 'export' && (
          <ExportHub
            activeProject={activeProject}
            stateVector={stateVector}
            wsConnected={wsConnected}
            onRefreshState={() => refreshPipelineState()}
            onNotify={notify}
          />
        )}
      </main>

      {showNewProjectModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4">
          <div className="liquid-glass w-full max-w-sm p-5 space-y-4">
            <h2 className="text-base font-bold text-white">New Production Project</h2>
            <form onSubmit={handleCreateProject} className="space-y-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Project Title</label>
                <input
                  type="text"
                  required
                  value={newProjName}
                  onChange={(e) => setNewProjName(e.target.value)}
                  placeholder="e.g. Episode #1: Hidden Compounding"
                  className="w-full px-3.5 py-2.5 rounded-2xl bg-slate-900/90 border border-white/10 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Channel niche
                </label>
                <input
                  type="text"
                  required
                  value={newProjNiche}
                  onChange={(e) => setNewProjNiche(e.target.value)}
                  placeholder="e.g. Personal finance for students, Retro gaming history, Hindi stand-up recaps"
                  className="w-full px-3.5 py-2.5 rounded-2xl bg-slate-900/90 border border-white/10 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Target Runtime (Minutes): {newProjDuration}m
                </label>
                <input
                  type="range"
                  min={2}
                  max={25}
                  value={newProjDuration}
                  onChange={(e) => setNewProjDuration(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] text-slate-400">Workflow Entry Mode</label>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setNewProjEntryMode('FULL')}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      newProjEntryMode === 'FULL'
                        ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 font-semibold'
                        : 'bg-slate-900/80 border-white/10 text-slate-400'
                    }`}
                  >
                    <div className="text-[11px] font-bold text-white">Full Engine</div>
                    <div className="text-[10px] text-slate-400">Topics → Research → Script → Storyboard</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewProjEntryMode('EXPRESS')}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      newProjEntryMode === 'EXPRESS'
                        ? 'bg-violet-500/20 border-violet-500 text-violet-300 font-semibold'
                        : 'bg-slate-900/80 border-white/10 text-slate-400'
                    }`}
                  >
                    <div className="text-[11px] font-bold text-white">Express Transcript</div>
                    <div className="text-[10px] text-slate-400">Have transcript → Storyboard & Packaging</div>
                  </button>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewProjectModal(false)}
                  className="flex-1 py-2.5 rounded-xl bg-slate-800 text-slate-300 text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingProject}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-500 text-slate-950 text-xs font-semibold"
                >
                  {creatingProject ? 'Creating...' : 'Create Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {needsTokenModal && mode === 'termux' && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="liquid-glass w-full max-w-sm p-5 space-y-4">
            <div className="flex items-center gap-2 text-emerald-400">
              <Key className="w-5 h-5" />
              <h2 className="text-base font-bold text-white">Local Access Token</h2>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Paste your local token from <code className="font-mono">~/.showrunner_token</code> to
              unlock this session.
            </p>
            <form onSubmit={handleSaveToken} className="space-y-3">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Paste bearer token..."
                className="w-full px-3.5 py-2.5 rounded-2xl bg-slate-900 border border-white/10 font-mono text-xs text-white"
              />
              <button
                type="submit"
                className="w-full py-3 rounded-2xl bg-emerald-500 text-slate-950 font-semibold text-xs"
              >
                Unlock Session
              </button>
            </form>
          </div>
        </div>
      )}

      <BottomNav
        activeHub={activeHub}
        onSelectHub={setActiveHub}
        stateVector={stateVector}
      />
    </div>
  );
}
