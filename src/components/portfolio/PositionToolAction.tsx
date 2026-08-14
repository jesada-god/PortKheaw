'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, LineChart, Lock } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { PLAN_DISPLAY_NAME } from '@/src/lib/subscription/upgrade-copy';
import { toolRequiredTier } from '@/src/lib/tools/catalog';
import {
  toolHandoffHref,
  toolsForAssetType,
  type PortfolioToolContext,
} from '@/src/lib/tools/handoff';

/**
 * The way out of a position and into a tool that can actually read it.
 *
 * A reader holding an ASTS $73 Put had no route to the simulator at all: they
 * had to leave the portfolio, open เครื่องมือ, pick between three tools with no
 * way to tell which one takes a contract, and then retype the whole position
 * into it. The one card that knows what they hold is this one, so the route
 * starts here — and because it starts from the position, the asset type decides
 * which tools are even offered. An option can only reach the two option
 * simulators; a share or an ETF can only reach the planner.
 *
 * Deliberately styled apart from the transaction actions beside it. Those write
 * to the ledger; this one opens a calculator and changes nothing, and a reader
 * who cannot tell them apart is one tap from recording a trade they meant to
 * simulate. Hence its own row, its own outline, and a chart glyph rather than a
 * verb.
 *
 * The entitlement check here is the prompt, not the gate. The two simulators are
 * refused by their compute routes and the planner by its own server page, so a
 * reader who edits the URL still gets nothing — this only means they meet the
 * upgrade dialog instead of a locked screen.
 */
export function PositionToolAction({
  context,
  label,
  source,
  disabled = false,
  className,
}: {
  context: PortfolioToolContext;
  /** The button's own words — "จำลองสถานการณ์" for a contract, "วางแผน" for shares. */
  label: string;
  /** Where the paywall telemetry says the prompt came from. */
  source: string;
  disabled?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const { can, requestUpgrade } = useEntitlement();
  const [chooserOpen, setChooserOpen] = useState(false);
  const tools = toolsForAssetType(context.type);
  if (tools.length === 0) return null;

  function open(toolId: string) {
    const tool = tools.find((item) => item.id === toolId);
    const href = tool ? toolHandoffHref(tool, context) : null;
    if (!tool || !href) return;
    setChooserOpen(false);
    if (!can(tool.capability)) {
      requestUpgrade({ capability: tool.capability, source: `${source}.${tool.id}` });
      return;
    }
    router.push(href);
  }

  return <>
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      data-testid={`position-tool-${context.type}`}
      data-tool-count={tools.length}
      className={className}
      // A single-tool asset has nothing to choose between, so it opens directly.
      onClick={() => { if (tools.length === 1) open(tools[0].id); else setChooserOpen(true); }}
    >
      <LineChart aria-hidden="true" size={15} className="mr-1.5" /> {label}
    </Button>

    <Modal
      isOpen={chooserOpen}
      onClose={() => setChooserOpen(false)}
      title={`เครื่องมือสำหรับ ${context.symbol}`}
      className="max-w-md"
    >
      <div className="min-w-0 space-y-3" data-testid="position-tool-chooser">
        <p className="break-words text-xs text-[var(--text-muted)]">
          เครื่องมือเหล่านี้ใช้คำนวณและทดลองสถานการณ์เท่านั้น ไม่ได้บันทึกรายการซื้อขายในพอร์ต
        </p>
        {tools.map((tool) => {
          const tier = toolRequiredTier(tool);
          const unlocked = can(tool.capability);
          return <button
            key={tool.id}
            type="button"
            data-testid={`position-tool-option-${tool.id}`}
            data-locked={unlocked ? 'false' : 'true'}
            onClick={() => open(tool.id)}
            className="flex w-full min-w-0 items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3.5 text-left transition-colors hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <strong className="min-w-0 break-words text-sm font-bold text-[var(--text)]">{tool.title}</strong>
                {tier && <span className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)] ring-1 ring-[var(--border-strong)]">
                  {!unlocked && <Lock aria-hidden="true" size={9} />}{PLAN_DISPLAY_NAME[tier]}
                </span>}
              </span>
              <span className="mt-1 block break-words text-xs leading-5 text-[var(--text-muted)]">{tool.description}</span>
            </span>
            <ChevronRight aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
          </button>;
        })}
      </div>
    </Modal>
  </>;
}
