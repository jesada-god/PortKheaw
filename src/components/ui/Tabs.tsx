'use client';
import * as React from "react"
import { cn } from "@/src/utils/cn"

interface TabsProps {
  tabs: string[]
  activeTab: string
  onChange: (tab: string) => void
  className?: string
}

/**
 * The app's tab strip, as an underlined rail rather than a row of pills.
 *
 * The pills it replaces were the most template-looking control in the product:
 * `text-[10px] uppercase tracking-widest` inside a bordered capsule, which is a
 * treatment that says "generic dashboard" before it says which section you are
 * in — and at 10px micro-caps the names were also the hardest text on the page
 * to read. Names are now set at their natural case and size, and the thing that
 * marks the current one is a 2px accent rule sitting on the strip's own
 * baseline: the pattern an analysis tool uses, and one that costs no box.
 *
 * Structure is two elements for one reason. The rule belongs to the OUTER
 * element and the scroll belongs to the inner one, because `overflow-x: auto`
 * computes `overflow-y: auto` as well, and a marker that hangs even a pixel
 * below its scroll container gets clipped by it. `-mb-px` slides the rail down
 * so each tab's own bottom border lands exactly on the shared rule.
 *
 * Deliberately still plain `<button>`s. Adding `role="tablist"`/`role="tab"`
 * would promise a matching `tabpanel` and roving focus that the call sites do
 * not implement, which reads worse to a screen reader than honest buttons.
 */
export function Tabs({ tabs, activeTab, onChange, className }: TabsProps) {
  return (
    <div className={cn("min-w-0 border-b border-[var(--hairline)]", className)}>
      <div className="-mb-px flex min-w-0 gap-5 overflow-x-auto scrollbar-hide sm:gap-6">
        {tabs.map((tab) => {
          const active = activeTab === tab
          return (
            <button
              key={tab}
              type="button"
              onClick={() => onChange(tab)}
              aria-current={active ? 'true' : undefined}
              className={cn(
                "shrink-0 whitespace-nowrap border-b-2 px-0.5 text-sm font-semibold transition-colors",
                active
                  ? "border-[var(--accent)] text-[var(--text)]"
                  : "border-transparent text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
              )}
            >
              {tab}
            </button>
          )
        })}
      </div>
    </div>
  )
}
