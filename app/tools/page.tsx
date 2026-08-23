'use client';
import Header from '@/src/components/layout/Header';
import { Shuffle, TrendingUp, Target, ChevronRight, Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { PLAN_DISPLAY_NAME, upgradeCopy } from '@/src/lib/subscription/upgrade-copy';
import { TOOL_ASSET_SCOPE_LABEL, TOOL_CATALOG, TOOL_CATEGORIES, toolRequiredTier, type ToolCatalogEntry } from '@/src/lib/tools/catalog';

/** Presentation only — which tool wears which glyph. Never a tier. */
const toolIcons: Record<string, typeof Shuffle> = {
  'what-if': Shuffle,
  'monte-carlo': TrendingUp,
  'stock-planner': Target,
};

export default function ToolsPage() {
  const router = useRouter();
  const { can, requestUpgrade } = useEntitlement();

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

      <div className="w-full max-w-full min-w-0 space-y-8 p-4 md:p-8">
        {/*
          Two small headings instead of a tab strip. The categories are the same
          ones the catalog already declares, so nothing moved between groups —
          but a reader now sees every tool at once, and sees which instrument
          each group is about, without first choosing a filter. One less control
          to operate before the page says anything.
        */}
        {TOOL_CATEGORIES.map((category) => {
          const tools = TOOL_CATALOG.filter((tool) => tool.category === category);
          if (tools.length === 0) return null;
          return (
            <section key={category} className="min-w-0">
              <h2 className="section-eyebrow">{category}</h2>
              <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {tools.map((tool) => {
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
                      /*
                        A tool, presented as a tool. What was here before was the
                        archetypal SaaS feature card: a 48px tinted icon plate, a
                        heavy shadow, and a decorative quarter-circle blob sliding
                        under the corner on hover. The blob is gone — it carried no
                        information and was the single most template-looking mark in
                        the product — and the plate is now a small glyph sitting
                        beside the name it belongs to, at the size an icon needs to
                        be to identify something rather than to decorate it.

                        Border and surface only, no shadow: these are peers in a
                        catalogue, and elevation would claim one of them outranks
                        the others.
                      */
                      className="group relative flex min-w-0 flex-col justify-between rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] sm:p-5"
                    >
                      <div className="min-w-0">
                        <div className="mb-2 flex min-w-0 items-start gap-3">
                          <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] ${
                            unlocked ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--surface-elevated)] text-[var(--text-muted)]'
                          }`}>
                            <Icon size={18} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <h3 className="break-words text-base font-bold leading-snug text-[var(--text)] transition-colors group-hover:text-[var(--accent)]">{tool.title}</h3>
                          </span>
                          {planName && (
                            <span className={`inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-mark)] px-2 py-1 text-[11px] font-bold ${
                              unlocked
                                ? 'bg-[var(--surface-elevated)] text-[var(--text-muted)]'
                                : 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            }`}>
                              {!unlocked && <Lock aria-hidden="true" size={10} />}
                              {planName}
                            </span>
                          )}
                        </div>
                        <p className="break-words text-sm leading-6 text-[var(--text-secondary)]">{tool.description}</p>
                        {!unlocked && (
                          <>
                            {/*
                              A locked card used to say only which plan it needs, which
                              tells a reader the price of something they still cannot
                              picture. This is static educational copy from the catalog:
                              no request is made, nothing is computed, and none of it is
                              the paid tool's own output — the ตัวอย่าง line is labelled
                              precisely so it cannot be read as a number about their own
                              positions.
                            */}
                            <div className="inset mt-4 min-w-0 p-3">
                              <p className="section-eyebrow">
                                ปลดล็อกแล้วได้อะไร
                              </p>
                              <ul className="mt-2 min-w-0 space-y-1.5">
                                {tool.valuePreview.map((item) => (
                                  <li key={item} className="flex min-w-0 gap-2 text-xs leading-5 text-[var(--text-secondary)]">
                                    <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-[var(--accent)]" />
                                    <span className="min-w-0 break-words">{item}</span>
                                  </li>
                                ))}
                              </ul>
                              <p className="mt-2 min-w-0 break-words text-[11px] leading-5 text-[var(--text-muted)]">
                                <span className="mr-1 rounded-[var(--radius-mark)] bg-[var(--surface-selected)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]">ตัวอย่าง</span>
                                {tool.sampleOutcome}
                              </p>
                            </div>
                            <p className="mt-3 break-words text-xs text-[var(--text-muted)]">{copy.lockedLabel}</p>
                          </>
                        )}
                      </div>

                      {/*
                        The row under the rule used to repeat the category heading
                        printed directly above the grid. What a reader actually needs
                        before opening a tool is the instrument it takes, so that label
                        moves down here and the duplicate goes.
                      */}
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline)] pt-3">
                        <span data-testid={`tool-scope-${tool.id}`} className="min-w-0 break-words text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                          {TOOL_ASSET_SCOPE_LABEL[tool.assetScope]}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-sm font-bold text-[var(--accent)]">
                          {unlocked ? 'ใช้งาน' : 'อัปเกรด'} <ChevronRight size={16} />
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
