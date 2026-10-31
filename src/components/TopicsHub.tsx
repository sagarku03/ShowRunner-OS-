import React, { useState } from 'react';
import {
  Compass,
  Sparkles,
  Lock,
  ShieldBan,
  Plus,
  CheckCircle2,
  SlidersHorizontal,
  ArrowRight,
} from 'lucide-react';
import type {
  CustomTopicAlignmentResult,
  PipelineStateVector,
  ProjectItem,
  S1StagePayload,
  TopicCard,
} from '../types/showrunner.ts';
import { apiRequest } from '../utils/apiClient.ts';

interface TopicsHubProps {
  activeProject: ProjectItem | null;
  stateVector: PipelineStateVector | null;
  onRefreshState: () => Promise<void>;
  onNotify: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const TopicsHub: React.FC<TopicsHubProps> = ({
  activeProject,
  stateVector,
  onRefreshState,
  onNotify,
}) => {
  const s1Summary = stateVector?.context?.S1;
  const rawS1 = (s1Summary?.payload as S1StagePayload | null) ?? null;
  const s1Payload =
    rawS1 && (Array.isArray(rawS1.candidates) || rawS1.lockedTopic) ? rawS1 : null;

  const [modeTab, setModeTab] = useState<'ideate' | 'custom'>('ideate');
  const [niche, setNiche] = useState(activeProject?.niche ?? '');
  const [customTopic, setCustomTopic] = useState('');
  const [loading, setLoading] = useState(false);
  const [lockingId, setLockingId] = useState<string | null>(null);
  const [customResult, setCustomResult] = useState<CustomTopicAlignmentResult | null>(
    s1Payload?.customAlignment ?? null
  );

  const [blacklistTitle, setBlacklistTitle] = useState('');
  const [blacklistAnchor, setBlacklistAnchor] = useState('');
  const [blacklistItems, setBlacklistItems] = useState<
    Array<{ id: number; topicTitle: string; bannedAnchor: string }>
  >([]);

  React.useEffect(() => {
    if (activeProject?.niche) {
      setNiche(activeProject.niche);
    }
    if (activeProject) {
      void apiRequest<{
        items: Array<{ id: number; topicTitle: string; bannedAnchor: string }>;
      }>('/api/v1/blacklist').then((res) => setBlacklistItems(res.items || []));
    }
  }, [activeProject]);

  const handleIdeate10Cards = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProject) {
      onNotify('Create or select a project first', 'warn');
      return;
    }
    setLoading(true);
    try {
      await apiRequest('/api/v1/stage/1/topics', {
        method: 'POST',
        body: {
          mode: 'ideate',
          niche: niche.trim() || activeProject.niche,
        },
      });
      await onRefreshState();
      onNotify('Generated 10 high-retention topic cards', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEvaluateCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProject || !customTopic.trim()) return;
    setLoading(true);
    try {
      const res = await apiRequest<CustomTopicAlignmentResult>('/api/v1/stage/1/topics', {
        method: 'POST',
        body: {
          mode: 'custom',
          topic: customTopic.trim(),
          niche: niche.trim() || activeProject.niche,
        },
      });
      setCustomResult(res);
      await onRefreshState();
      if (res.aligned) {
        onNotify(`Custom topic aligned (${res.score}/100) & locked!`, 'success');
      } else {
        onNotify(
          `Alignment score ${res.score}/100 (< 70). Choose a reframing angle below.`,
          'warn'
        );
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectCard = async (card: TopicCard) => {
    setLockingId(card.id);
    try {
      await apiRequest('/api/v1/stage/1/topics', {
        method: 'POST',
        body: {
          mode: 'lock',
          topicId: card.id,
          customTopic: card,
        },
      });
      await onRefreshState();
      onNotify(`Locked topic: "${card.title}"`, 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLockingId(null);
    }
  };

  const handleLockReframedAngle = async (angleTitle: string) => {
    setLockingId(angleTitle);
    try {
      await apiRequest('/api/v1/stage/1/topics', {
        method: 'POST',
        body: {
          mode: 'lock',
          customTopic: {
            title: angleTitle,
            hook15s: `Within 15 seconds, the unseen mechanism of ${angleTitle} triggers an immediate physiological response.`,
            coreParadox: `Why conventional wisdom on ${angleTitle} collapses under forensic scrutiny.`,
            thumbnailIdea: 'FORENSIC SHOCK',
            retentionScore: 88,
            mdviScore: 84,
          },
        },
      });
      await onRefreshState();
      onNotify(`Locked reframed angle: "${angleTitle}"`, 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLockingId(null);
    }
  };

  const handleAddBlacklist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!blacklistTitle.trim()) return;
    try {
      const res = await apiRequest<{
        entry: { id: number; topicTitle: string; bannedAnchor: string };
      }>('/api/v1/blacklist', {
        method: 'POST',
        body: {
          topicTitle: blacklistTitle.trim(),
          bannedAnchor: blacklistAnchor.trim() || blacklistTitle.trim(),
        },
      });
      setBlacklistItems((prev) => [res.entry, ...prev]);
      setBlacklistTitle('');
      setBlacklistAnchor('');
      onNotify('Added to Blacklist Catalog', 'warn');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const candidates = s1Payload?.candidates ?? [];
  const lockedTopic = s1Payload?.lockedTopic ?? null;

  return (
    <div className="space-y-5 pb-28">
      {lockedTopic && (
        <section className="liquid-glass p-4 border-emerald-500/40 bg-emerald-500/10 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" />
              Locked Production Topic
            </span>
            <span className="font-mono text-xs text-emerald-300">
              {(lockedTopic.title || '').length}/60 chars • Score {lockedTopic.retentionScore ?? 0}
            </span>
          </div>
          <h3 className="text-sm font-bold text-white">{lockedTopic.title}</h3>
          <p className="text-xs text-slate-300">
            {lockedTopic.hook15s || lockedTopic.hook}
          </p>
        </section>
      )}

      <section className="liquid-glass p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Compass className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Topic Engine</h2>
              <p className="text-xs text-slate-400">10-Card Matrix or Custom Alignment</p>
            </div>
          </div>

          <div className="flex rounded-xl bg-slate-900/90 p-1 border border-white/10">
            <button
              type="button"
              onClick={() => setModeTab('ideate')}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                modeTab === 'ideate'
                  ? 'bg-emerald-500 text-slate-950 font-semibold'
                  : 'text-slate-400'
              }`}
            >
              Option A (10 Cards)
            </button>
            <button
              type="button"
              onClick={() => setModeTab('custom')}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                modeTab === 'custom'
                  ? 'bg-violet-500 text-white font-semibold'
                  : 'text-slate-400'
              }`}
            >
              Option B (Custom)
            </button>
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-slate-400 mb-1">
            Channel niche
          </label>
          <input
            type="text"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="e.g. Personal finance for students, Retro gaming history, Hindi stand-up recaps"
            className="w-full px-3.5 py-2.5 rounded-2xl bg-slate-900/80 border border-white/10 text-xs text-white"
          />
        </div>

        {modeTab === 'ideate' ? (
          <form onSubmit={handleIdeate10Cards}>
            <button
              type="submit"
              disabled={loading || !activeProject}
              className="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
            >
              <Sparkles className="w-4 h-4" />
              {loading ? 'Generating 10 Topic Cards...' : 'Generate 10 High-Retention Cards'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleEvaluateCustom} className="space-y-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-400 mb-1">
                Custom Topic Proposal
              </label>
              <input
                type="text"
                value={customTopic}
                onChange={(e) => setCustomTopic(e.target.value)}
                placeholder="Enter custom topic idea (< 60 chars)..."
                className="w-full px-3.5 py-2.5 rounded-2xl bg-slate-900/80 border border-white/10 text-xs text-white"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !customTopic.trim() || !activeProject}
              className="w-full py-3.5 rounded-2xl bg-violet-500 hover:bg-violet-400 disabled:opacity-40 text-white font-semibold text-xs flex items-center justify-center gap-2 active:scale-[0.97]"
            >
              <SlidersHorizontal className="w-4 h-4" />
              {loading ? 'Checking Semantic Alignment...' : 'Evaluate Alignment & Lock'}
            </button>
          </form>
        )}

        {customResult && modeTab === 'custom' && (
          <div className="liquid-glass-subtle p-4 space-y-3 border border-violet-500/30">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">
                Semantic Alignment Score
              </span>
              <span
                className={`px-2.5 py-0.5 rounded-full font-mono text-xs font-semibold ${
                  customResult.aligned
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                }`}
              >
                {customResult.score}/100 {customResult.aligned ? 'ALIGNED' : 'REFRAME NEEDED'}
              </span>
            </div>
            <p className="text-xs text-slate-300">{customResult.reasoning}</p>
            {!customResult.aligned && (
              <div className="space-y-2 pt-1">
                <div className="text-[11px] font-semibold text-violet-300">
                  3 Reframing Angles (Tap to Lock):
                </div>
                {(customResult.reframingAngles || []).map((angle, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleLockReframedAngle(angle)}
                    className="w-full p-3 rounded-xl bg-slate-900/90 hover:bg-violet-500/15 border border-white/10 text-left text-xs text-white flex items-center justify-between gap-2 active:scale-[0.97]"
                  >
                    <span>{angle}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {candidates.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Candidate Matrix ({candidates.length} Cards)
            </h3>
            <span className="text-[11px] text-emerald-400 font-mono">Viability &ge; 70</span>
          </div>

          {candidates.map((card) => {
            const isLocked = lockedTopic?.id === card.id || lockedTopic?.title === card.title;
            return (
              <div
                key={card.id}
                className={`liquid-glass p-4 space-y-2.5 transition-all ${
                  isLocked ? 'border-emerald-500/50 bg-emerald-500/10' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h4 className="text-sm font-bold text-white leading-snug">{card.title}</h4>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="px-2 py-0.5 rounded-lg bg-violet-500/20 text-violet-300 font-mono text-[10px]">
                      Ret {card.retentionScore}
                    </span>
                    <span className="px-2 py-0.5 rounded-lg bg-emerald-500/20 text-emerald-300 font-mono text-[10px]">
                      Viability {card.mdviScore}
                    </span>
                  </div>
                </div>

                <div className="text-xs text-slate-300 space-y-1">
                  <p>
                    <strong className="text-emerald-400">15s Opening Hook:</strong>{' '}
                    {card.hook15s || card.hook}
                  </p>
                  <p>
                    <strong className="text-violet-400">Core Paradox:</strong>{' '}
                    {card.coreParadox || card.paradox}
                  </p>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="px-2.5 py-1 rounded-lg bg-slate-900/90 border border-white/10 font-mono text-[11px] text-amber-300">
                    Thumb: {card.thumbnailIdea || card.thumbnailBoldWords}
                  </span>

                  <button
                    type="button"
                    onClick={() => handleSelectCard(card)}
                    disabled={lockingId === card.id}
                    className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 active:scale-[0.97] ${
                      isLocked
                        ? 'bg-emerald-500 text-slate-950'
                        : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30'
                    }`}
                  >
                    <Lock className="w-3.5 h-3.5" />
                    {isLocked ? 'Locked' : 'Lock Topic'}
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="liquid-glass p-5 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldBan className="w-4 h-4 text-rose-400" />
          <h3 className="text-sm font-semibold text-white">Blacklist Catalog</h3>
        </div>
        <form onSubmit={handleAddBlacklist} className="flex gap-2">
          <input
            type="text"
            value={blacklistTitle}
            onChange={(e) => setBlacklistTitle(e.target.value)}
            placeholder="Ban topic or anchor..."
            className="flex-1 px-3 py-2 rounded-xl bg-slate-900/80 border border-white/10 text-xs text-white"
          />
          <button
            type="submit"
            className="px-3.5 py-2 rounded-xl bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-semibold flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            Ban
          </button>
        </form>
        {blacklistItems.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {blacklistItems.map((item) => (
              <span
                key={item.id}
                className="px-2.5 py-1 rounded-lg bg-rose-950/60 border border-rose-500/30 text-[11px] text-rose-200"
              >
                {item.topicTitle}
              </span>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
