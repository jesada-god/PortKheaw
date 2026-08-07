'use client';
import { useState } from 'react';
import Header from '@/src/components/layout/Header';
import { Shuffle, TrendingUp, ChevronRight, Lock } from 'lucide-react';
import { Tabs } from '@/src/components/ui/Tabs';
import { useRouter } from 'next/navigation';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { PLAN_DISPLAY_NAME, upgradeCopy } from '@/src/lib/subscription/upgrade-copy';
import { TOOL_CATALOG, TOOL_CATEGORIES, toolRequiredTier, type ToolCatalogEntry } from '@/src/lib/tools/catalog';

/** Presentation only — which tool wears which glyph. Never a tier. */
const toolIcons: Record<string, typeof Shuffle> = {
  'what-if': Shuffle,
  'monte-carlo': TrendingUp,
};

const ALL = 'ทั้งหมด';

export default function ToolsPage() {
  const router = useRouter();
  const { can, requestUpgrade } = useEntitlement();
  const [activeTab, setActiveTab] = useState<string>(ALL);

  const filteredTools = activeTab === ALL
    ? TOOL_CATALOG
    : TOOL_CATALOG.filter((tool) => tool.category === activeTab);

  /*
    A locked card opens the same upgrade prompt every other locked surface opens,
    rather than routing to a workspace whose every control is padlocked. The
    prompt names the plan the matrix returned, so the badge and the dialog can
    never disagree.
  */
  function activate(tool: ToolCatalogEntry, unlocked: boolean) {
    if (unlocked) {
      router.push(tool.route);
      return;
    }
    requestUpgrade({ capability: tool.capability, source: `tools.card.${tool.id}` });
  }

  return (
    <div>
      <Header title="เครื่องมือ" subtitle="ทดลองสถานการณ์และดูความเสี่ยงก่อนตัดสินใจ" />

      <div className="w-full max-w-full min-w-0 space-y-6 p-4 md:p-8">
        <Tabs
          tabs={[ALL, ...TOOL_CATEGORIES]}
          activeTab={activeTab}
          onChange={setActiveTab}
        />

        <div className="mt-6 grid min-w-0 grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {filteredTools.map((tool) => {
            const Icon = toolIcons[tool.id] ?? Shuffle;
            const tier = toolRequiredTier(tool);
            const unlocked = can(tool.capability);
            const planName = tier ? PLAN_DISPLAY_NAME[tier] : null;
            const copy = upgradeCopy(tool.capability);
            return (
              <button
                key={tool.id}
                type="button"
                onClick={() => activate(tool, unlocked)}
                data-testid={`tool-card-${tool.id}`}
                data-capability={tool.capability}
                data-required-tier={tier ?? ''}
                data-locked={unlocked ? 'false' : 'true'}
                aria-label={unlocked ? tool.title : `${tool.title} — ต้องใช้แพ็กเกจ ${planName ?? ''}`}
                className="group relative flex min-w-0 flex-col justify-between overflow-hidden rounded-2xl border border-slate-800 bg-[#151B28] p-6 text-left shadow-xl transition-all hover:border-[#D4FF00]/50 hover:bg-[#1e293b]"
              >
                <div className="pointer-events-none absolute right-0 top-0 -mr-8 -mt-8 h-32 w-32 rounded-bl-full bg-slate-800/20 transition-transform group-hover:scale-110" />

                <div className="relative z-10 min-w-0">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
                      unlocked ? 'bg-[#D4FF00]/10 text-[#D4FF00]' : 'bg-purple-500/10 text-purple-400'
                    }`}>
                      <Icon size={24} />
                    </div>
                    {planName && (
                      <span className={`inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${
                        unlocked ? 'bg-[#1e293b] text-slate-400' : 'bg-purple-500/20 text-purple-400'
                      }`}>
                        {!unlocked && <Lock aria-hidden="true" size={10} />}
                        {planName}
                      </span>
                    )}
                  </div>
                  <h3 className="mb-2 break-words text-lg font-bold text-white transition-colors group-hover:text-[#D4FF00]">{tool.title}</h3>
                  <p className="break-words text-sm leading-relaxed text-slate-400">{tool.description}</p>
                  {!unlocked && <p className="mt-2 break-words text-xs text-purple-400">{copy.lockedLabel}</p>}
                </div>

                <div className="relative z-10 mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
                  <span className="min-w-0 break-words text-[10px] uppercase tracking-widest text-slate-500">{tool.category}</span>
                  <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-[#D4FF00]">
                    {unlocked ? 'ใช้งาน' : `อัปเกรดเป็น ${planName ?? ''}`} <ChevronRight size={16} />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
