import { cn } from "@/src/utils/cn"

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    // A semantic surface rather than `bg-slate-800/50`: the hardcoded slate was
    // a dark-mode value that the compat layer had to rescue in light, and a
    // placeholder should simply be the elevated surface it will be replaced by.
    <div
      className={cn("animate-pulse rounded-[var(--radius-control)] bg-[var(--surface-elevated)]", className)}
      {...props}
    />
  )
}
