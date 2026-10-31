import React from 'react';
import { Shield, Compass, Cpu, FileText, PackageCheck } from 'lucide-react';
import type { HubId, PipelineStateVector } from '../types/showrunner.ts';

interface BottomNavProps {
  activeHub: HubId;
  onSelectHub: (hub: HubId) => void;
  stateVector: PipelineStateVector | null;
}

const HUB_ITEMS: ReadonlyArray<{
  id: HubId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  stages: string[];
}> = [
  { id: 'vault', label: 'Vault', icon: Shield, stages: ['S0'] },
  { id: 'topics', label: 'Topics', icon: Compass, stages: ['S1'] },
  { id: 'studio', label: 'Studio', icon: Cpu, stages: ['S2', 'S2.5'] },
  { id: 'script', label: 'Script', icon: FileText, stages: ['S3', 'S4', 'S5'] },
  { id: 'export', label: 'Export', icon: PackageCheck, stages: ['S6', 'S7'] },
];

export const BottomNav: React.FC<BottomNavProps> = ({
  activeHub,
  onSelectHub,
  stateVector,
}) => {
  const getHubBadgeColor = (stages: string[]): string | null => {
    if (!stateVector) return null;
    const states = stages.map((s) => stateVector.context[s]);
    if (
      states.some(
        (st) => st?.isDirty || st?.status === 'DIRTY' || st?.status === 'INVALIDATED'
      )
    ) {
      return 'bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.8)]';
    }
    if (states.some((st) => st?.status === 'FAILED')) {
      return 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)]';
    }
    if (states.every((st) => st?.status === 'PASSED')) {
      return 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.8)]';
    }
    return null;
  };

  return (
    <nav
      aria-label="Primary Hub Navigation"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-24px)] max-w-md h-16 liquid-dock rounded-full px-2 flex items-center justify-around"
    >
      {HUB_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = activeHub === item.id;
        const badgeClass = getHubBadgeColor(item.stages);

        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectHub(item.id)}
            className={`relative flex flex-col items-center justify-center w-16 h-12 rounded-full transition-all duration-200 active:scale-[0.97] ${
              isActive
                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {badgeClass && (
              <span
                className={`absolute top-1.5 right-3 w-2 h-2 rounded-full ${badgeClass}`}
              />
            )}
            <Icon className="w-5 h-5" />
            <span className="text-[11px] font-medium tracking-tight mt-0.5">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
};
