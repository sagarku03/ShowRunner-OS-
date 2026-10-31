import React, { useState } from 'react';
import {
  Search,
  CheckCircle2,
  ShieldCheck,
  ExternalLink,
  Layers,
  Clock,
  Sliders,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Save,
} from 'lucide-react';
import {
  DURATION_PRESET_CHIPS,
  WPM_MAX,
  WPM_MIN,
  type DurationPresetChip,
} from '../config/constants.ts';
import type {
  EvidenceRow,
  PipelineStateVector,
  ProjectItem,
  S2StagePayload,
  S25StagePayload,
} from '../types/showrunner.ts';
import { apiRequest } from '../utils/apiClient.ts';

interface StudioHubProps {
  activeProject: ProjectItem | null;
  stateVector: PipelineStateVector | null;
  onRefreshState: () => Promise<void>;
  onNotify: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const StudioHub: React.FC<StudioHubProps> = ({
  activeProject,
  stateVector,
  onRefreshState,
  onNotify,
}) => {
  const rawS2 = (stateVector?.context?.S2?.payload as S2StagePayload | null) ?? null;
  const s2Payload =
    rawS2 && (rawS2.shockPoint || Array.isArray(rawS2.evidence)) ? rawS2 : null;

  const rawS25 = (stateVector?.context?.['S2.5']?.payload as S25StagePayload | null) ?? null;
  const s25Payload =
    rawS25 && rawS25.wordBudget && Array.isArray(rawS25.chapters) ? rawS25 : null;

  const isExpressBypassed =
    activeProject?.entryMode === 'EXPRESS' ||
    stateVector?.context?.S2?.status === 'EXTERNAL_PROVIDED' ||
    stateVector?.context?.['S2.5']?.status === 'EXTERNAL_PROVIDED';

  const [runningResearch, setRunningResearch] = useState(false);
  const [approvingResearch, setApprovingResearch] = useState(false);

  const [selectedPreset, setSelectedPreset] = useState<DurationPresetChip>('10-12');
  const [targetMinutes, setTargetMinutes] = useState<number>(
    Number(s25Payload?.targetMinutes ?? activeProject?.targetDuration ?? 11) || 11
  );
  const [wpm, setWpm] = useState<number>(
    Number(s25Payload?.wpm ?? activeProject?.configuredWpm ?? 187.41) || 187.41
  );
  const [runningRuntime, setRunningRuntime] = useState(false);
  const [savingChapters, setSavingChapters] = useState(false);
  const [chapterEdits, setChapterEdits] = useState<Record<number, string>>({});

  React.useEffect(() => {
    if (s25Payload && Array.isArray(s25Payload.chapters)) {
      const next: Record<number, string> = {};
      for (const ch of s25Payload.chapters) {
        next[ch.phaseIndex] = ch.chapterTitle;
      }
      setChapterEdits(next);
      if (typeof s25Payload.targetMinutes === 'number' && Number.isFinite(s25Payload.targetMinutes)) {
        setTargetMinutes(s25Payload.targetMinutes);
      }
      if (typeof s25Payload.wpm === 'number' && Number.isFinite(s25Payload.wpm)) {
        setWpm(s25Payload.wpm);
      }
    }
  }, [s25Payload]);

  const handleRunGroundedResearch = async () => {
    setRunningResearch(true);
    try {
      await apiRequest('/api/v1/stage/2/research', { method: 'POST', body: {} });
      await onRefreshState();
      onNotify('Grounded research & evidence dossier ready for review', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setRunningResearch(false);
    }
  };

  const handleToggleEvidence = async (row: EvidenceRow) => {
    try {
      await apiRequest('/api/v1/stage/2/evidence', {
        method: 'PUT',
        body: {
          evidenceId: row.id,
          action: 'toggle',
        },
      });
      await onRefreshState();
      onNotify(
        `Evidence ${row.id} marked ${row.status === 'VERIFIED' ? 'EXCLUDED' : 'VERIFIED'} (Re-approval required)`,
        'warn'
      );
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleApproveDossier = async () => {
    setApprovingResearch(true);
    try {
      await apiRequest('/api/v1/stage/2/approve', { method: 'POST', body: {} });
      await onRefreshState();
      onNotify('Research Dossier approved! Runtime & Chapters unlocked.', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setApprovingResearch(false);
    }
  };

  const handleGenerateRuntimeAndChapters = async () => {
    setRunningRuntime(true);
    try {
      await apiRequest('/api/v1/stage/2_5/runtime', {
        method: 'POST',
        body: {
          targetMinutes,
          wpm,
          regenerate: true,
        },
      });
      await onRefreshState();
      onNotify('Word budget & 7 Harmon chapters generated', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setRunningRuntime(false);
    }
  };

  const handleSaveChapterTitles = async () => {
    if (!s25Payload) return;
    setSavingChapters(true);
    try {
      const chapters = s25Payload.chapters.map((c) => ({
        phaseIndex: c.phaseIndex,
        chapterTitle: chapterEdits[c.phaseIndex] ?? c.chapterTitle,
        narrativeBeat: c.narrativeBeat,
      }));
      await apiRequest('/api/v1/stage/2_5/runtime', {
        method: 'PUT',
        body: {
          targetMinutes,
          wpm,
          chapters,
        },
      });
      await onRefreshState();
      onNotify('Chapter titles saved', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSavingChapters(false);
    }
  };

  const presetMidpoints: Record<DurationPresetChip, number> = {
    '6-8': 7,
    '10-12': 11,
    '12-15': 13.5,
    '18-20': 19,
  };

  return (
    <div className="space-y-5 pb-28">
      {isExpressBypassed && (
        <div className="p-3.5 rounded-2xl bg-violet-500/10 border border-violet-500/25 text-xs text-slate-300">
          Running in <strong className="text-white">Express Transcript Mode</strong> — Grounded Research (S2) and Runtime Chapters (S2.5) are bypassed (<code className="font-mono text-violet-300">EXTERNAL_PROVIDED</code>). Use the <strong className="text-white">Script</strong> hub to upload or lock your transcript directly.
        </div>
      )}
      {/* STAGE 2: GROUNDED RESEARCH & HUMAN APPROVAL GATE */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-violet-400">
              <Search className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Grounded Dossier</h2>
              <p className="text-xs text-slate-400">Live Search + Evidence Verification</p>
            </div>
          </div>

          {s2Payload && (
            <span
              className={`px-2.5 py-1 rounded-xl font-mono text-[11px] font-semibold border ${
                s2Payload.approved
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
              }`}
            >
              {s2Payload.approved ? 'Approved' : 'Needs Approval'}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handleRunGroundedResearch}
          disabled={runningResearch || !activeProject}
          className="w-full py-3.5 rounded-2xl bg-violet-500 hover:bg-violet-400 disabled:opacity-40 text-white font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
        >
          <Sparkles className="w-4 h-4" />
          {runningResearch ? 'Running Grounded Search...' : 'Run Grounded Research'}
        </button>

        {s2Payload && (
          <div className="space-y-4 pt-2">
            {/* Shock Point */}
            <div className="liquid-glass-subtle p-3.5 border-l-4 border-l-emerald-400 space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                Primary Shock Fact
              </div>
              <p className="text-xs text-white font-medium">{s2Payload.shockPoint?.fact}</p>
              {s2Payload.shockPoint?.link && (
                <a
                  href={s2Payload.shockPoint.link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:underline"
                >
                  <span>{s2Payload.shockPoint.source}</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>

            {/* Evidence Table */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-300">
                  Traceable Evidence Table ({s2Payload.evidence?.length ?? 0} Rows)
                </h3>
                <span className="text-[11px] font-mono text-emerald-400">
                  Viability {s2Payload.mdvi?.score ?? 85}/100
                </span>
              </div>

              {(s2Payload.evidence || []).map((row) => (
                <div
                  key={row.id}
                  className="liquid-glass-subtle p-3 space-y-1.5 border border-white/10"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs text-white font-medium leading-snug">{row.claim}</p>
                    <button
                      type="button"
                      onClick={() => handleToggleEvidence(row)}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-semibold flex items-center gap-1 shrink-0 ${
                        row.status === 'VERIFIED'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                      }`}
                    >
                      {row.status === 'VERIFIED' ? (
                        <ToggleRight className="w-3.5 h-3.5" />
                      ) : (
                        <ToggleLeft className="w-3.5 h-3.5" />
                      )}
                      {row.status}
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>
                      {row.institution} ({row.year}) • {row.methodology}
                    </span>
                    {row.link && (
                      <a
                        href={row.link}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-400 hover:underline flex items-center gap-1"
                      >
                        Source
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Knowledge Triples */}
            {s2Payload.triples && s2Payload.triples.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-slate-300">
                  Knowledge Triples (Subject → Predicate → Object)
                </h3>
                <div className="space-y-1.5">
                  {s2Payload.triples.slice(0, 5).map((t, idx) => (
                    <div
                      key={idx}
                      className="px-3 py-2 rounded-xl bg-slate-900/80 border border-white/8 text-[11px] text-slate-200 font-mono"
                    >
                      <span className="text-emerald-400">{t.subject}</span> →{' '}
                      <span className="text-violet-300">{t.predicate}</span> →{' '}
                      <span className="text-white">{t.object}</span>{' '}
                      <span className="text-slate-500">[{t.evidenceId}]</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Human Approval Gate Button */}
            <button
              type="button"
              onClick={handleApproveDossier}
              disabled={approvingResearch || s2Payload.approved}
              className={`w-full py-3.5 rounded-2xl font-semibold text-xs flex items-center justify-center gap-2 transition-all active:scale-[0.97] ${
                s2Payload.approved
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              {s2Payload.approved
                ? 'Dossier Approved (Gate Open)'
                : approvingResearch
                  ? 'Approving Dossier...'
                  : 'Approve Evidence Dossier to Unlock Runtime'}
            </button>
          </div>
        )}
      </section>

      {/* STAGE 2.5: RUNTIME, WORD BUDGET & 7 HARMON CHAPTERS */}
      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Runtime & Chapters</h2>
              <p className="text-xs text-slate-400">Word Budget & 7 Story Circle Beats</p>
            </div>
          </div>
          <span className="font-mono text-xs text-emerald-400">
            {Math.round(targetMinutes * wpm)}w (±5%)
          </span>
        </div>

        {/* Duration Preset Chips */}
        <div className="grid grid-cols-4 gap-2">
          {DURATION_PRESET_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => {
                setSelectedPreset(chip);
                setTargetMinutes(presetMidpoints[chip]);
              }}
              className={`py-2 rounded-xl font-mono text-xs border transition-all active:scale-[0.97] ${
                selectedPreset === chip
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-semibold'
                  : 'bg-slate-900/70 border-white/10 text-slate-400'
              }`}
            >
              {chip}m
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-400">Exact Target Runtime (Minutes)</span>
              <span className="font-mono text-white font-semibold">{targetMinutes} min</span>
            </div>
            <input
              type="number"
              min={2}
              max={30}
              step={0.5}
              value={targetMinutes}
              onChange={(e) => setTargetMinutes(Number(e.target.value) || 11)}
              className="w-full px-3 py-2 rounded-xl bg-slate-900/80 border border-white/10 text-xs text-white font-mono"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-400 flex items-center gap-1">
                <Sliders className="w-3.5 h-3.5 text-violet-400" />
                Pace Calibration (160–210 WPM)
              </span>
              <span className="font-mono text-white font-semibold">{wpm.toFixed(2)} WPM</span>
            </div>
            <input
              type="range"
              min={WPM_MIN}
              max={WPM_MAX}
              step={0.5}
              value={wpm}
              onChange={(e) => setWpm(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={handleGenerateRuntimeAndChapters}
          disabled={runningRuntime || !s2Payload?.approved}
          className="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
        >
          <Layers className="w-4 h-4" />
          {runningRuntime ? 'Building 7 Harmon Chapters...' : 'Lock Runtime & Generate Chapters'}
        </button>

        {s25Payload?.wordBudget && (
          <div className="space-y-3 pt-2">
            <div className="liquid-glass-subtle p-3.5 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-[10px] text-slate-400">Target Words</div>
                <div className="font-mono text-sm font-bold text-white">
                  {s25Payload.wordBudget.totalWords ?? 0}
                </div>
                <div className="text-[10px] text-slate-500 font-mono">
                  {s25Payload.wordBudget.minWords ?? 0}–{s25Payload.wordBudget.maxWords ?? 0}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">Paragraphs</div>
                <div className="font-mono text-sm font-bold text-emerald-400">
                  {s25Payload.wordBudget.paragraphCount ?? 0}
                </div>
                <div className="text-[10px] text-slate-500 font-mono">~150w each</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">Sub-Loop Cadence</div>
                <div className="font-mono text-sm font-bold text-violet-300">
                  {s25Payload.wordBudget.subLoopMinWords ?? 0}–{s25Payload.wordBudget.subLoopMaxWords ?? 0}w
                </div>
                <div className="text-[10px] text-slate-500 font-mono">1.0–1.5× WPM</div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-300">
                  7 Story Circle Chapters (Editable)
                </h3>
                <button
                  type="button"
                  onClick={handleSaveChapterTitles}
                  disabled={savingChapters}
                  className="px-3 py-1 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1"
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingChapters ? 'Saving...' : 'Save Edits'}
                </button>
              </div>

              {(s25Payload.chapters || []).map((ch) => (
                <div key={ch.phaseIndex} className="liquid-glass-subtle p-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                    <span>
                      #{ch.phaseIndex} {ch.phaseName}
                    </span>
                    <span>
                      {ch.targetWords}w • {ch.paragraphCount}p
                    </span>
                  </div>
                  <input
                    type="text"
                    value={chapterEdits[ch.phaseIndex] ?? ch.chapterTitle}
                    onChange={(e) =>
                      setChapterEdits((prev) => ({
                        ...prev,
                        [ch.phaseIndex]: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 rounded-xl bg-slate-900/90 border border-white/10 text-xs text-white"
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
