import Image from "next/image"
import { LucideIcon } from "lucide-react"
import { cn } from "@/src/utils/cn"

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: React.ReactNode
  className?: string
  /**
   * Show Kheaw instead of the glyph.
   *
   * Reserved for a state that is a beginning rather than a blank — a list the
   * reader has not started yet, as opposed to a filter that matched nothing or
   * a tool waiting for its next input. That distinction is the whole reason
   * this is a flag and not the default: a mascot on every empty container is
   * decoration, and it stops meaning anything the third time it appears.
   *
   * The artwork is `10_empty_laptop.png`, the same file the portfolio's goal
   * card already uses for its own empty state, at the same 80px the portfolio's
   * empty-assets panel draws it. No new asset, no new variant, one proportion.
   */
  mascot?: boolean
}

/**
 * "There is nothing here yet", said once and quietly.
 *
 * It no longer draws its own card. Three of its four call sites already placed
 * it inside a panel, so the bordered box it used to carry produced a card
 * nested inside a card — the single clearest tell of a layout assembled from a
 * template rather than composed. The container is now the caller's decision,
 * which is the only place that knows whether one is needed.
 *
 * The glyph lost its filled disc for the same reason: a circle behind an icon
 * is a third container in a block whose whole job is to be unobtrusive. It
 * stays at muted weight so the sentence, not the picture, is what the reader
 * lands on. Hardcoded slate gave way to semantic tokens, so this reads
 * correctly in light as well as dark.
 */
export function EmptyState({ icon: Icon, title, description, action, className, mascot }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      {mascot
        ? <Image
          alt=""
          aria-hidden="true"
          className="h-20 w-auto object-contain"
          height={512}
          sizes="80px"
          src="/brand/10_empty_laptop.png"
          width={512}
        />
        : <Icon size={26} aria-hidden="true" className="text-[var(--text-muted)]" />}
      <h3 className={cn("text-base font-bold text-[var(--text)]", mascot ? "mt-4" : "mt-3")}>{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
