'use client';
import * as React from "react"
import { cn } from "@/src/utils/cn"

interface TabsProps {
  tabs: string[]
  activeTab: string
  onChange: (tab: string) => void
  className?: string
}

export function Tabs({ tabs, activeTab, onChange, className }: TabsProps) {
  return (
    <div className={cn("flex gap-2 overflow-x-auto scrollbar-hide", className)}>
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          className={cn(
            "px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest whitespace-nowrap transition-colors border",
            activeTab === tab
              ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border-transparent bg-[var(--surface-elevated)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  )
}
