'use client';
import Header from '@/src/components/layout/Header';
import { ChevronRight, Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { PLAN_DISPLAY_NAME } from '@/src/lib/subscription/upgrade-copy';
import { TOOL_ASSET_SCOPE_LABEL, TOOL_CATALOG, TOOL_CATEGORIES, toolRequiredTier, type ToolCatalogEntry } from '@/src/lib/tools/catalog';

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
          ONE SHAPE PER TOOL: name, one line, button.

          What each card used to carry, in order: a glyph plate, the name, a
          plan badge, the instrument scope, the description, a line about who
          the tool is for, and — while locked — a tinted "ปลดล็อกแล้วได้อะไร"
          box holding three bulleted outcomes and a labelled ตัวอย่าง sentence,
          then the lock line, then a footer repeating the category beside the
          action. Nine blocks to say what one tool does.

          All of it was written to sell a reader on opening the tool. A catalogue
          of three items does not need to be sold; it needs to be read. What is
          left is the name, the sentence that says what the tool does, the
          instrument it works on, and the button — and the plan badge, which is
          not copy but the answer to "can I open this".
        */}
        {TOOL_CATEGORIES.map((category) => {
          const tools = TOOL_CATALOG.filter((tool) => tool.category === category);
          if (tools.length === 0) return null;
          return (
            <section key={category} className="min-w-0">
              <h2 className="section-eyebrow">{category}</h2>
              <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {tools.map((tool) => {
                  const tier = toolRequiredTier(tool);
                  const unlocked = can(tool.capability);
                  const planName = tier ? PLAN_DISPLAY_NAME[tier] : null;
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
                        Border and surface only, no shadow: these are peers in a
                        catalogue, and elevation would claim one of them outranks
                        the others. The 36px tinted icon plate went with the rest
                        of the furniture — three tools do not need to be told
                        apart by picture.
                      */
                      className="group flex min-w-0 flex-col justify-between gap-4 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] sm:p-5"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <h3 className="min-w-0 break-words text-base font-bold leading-snug text-[var(--text)] transition-colors group-hover:text-[var(--accent)]">
                            {tool.title}
                          </h3>
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
                        <p className="mt-2 break-words text-sm leading-6 text-[var(--text-secondary)]">{tool.description}</p>
                        {/*
                          Which instrument the tool is for. It stays because it
                          is the one thing a reader cannot infer from the name —
                          somebody holding shares opening "ทดลองสถานการณ์" met a
                          form asking for a strike.
                        */}
                        <p data-testid={`tool-scope-${tool.id}`} className="mt-1.5 break-words text-xs text-[var(--text-muted)]">
                          {TOOL_ASSET_SCOPE_LABEL[tool.assetScope]}
                        </p>
                      </div>

                      <span className="flex shrink-0 items-center gap-1 text-sm font-bold text-[var(--accent)]">
                        {unlocked ? 'เปิดเครื่องมือ' : `อัปเกรดเป็น ${planName ?? ''}`}
                        <ChevronRight aria-hidden="true" size={16} />
                      </span>
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
