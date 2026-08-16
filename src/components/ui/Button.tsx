import * as React from "react"
import { cn } from "@/src/utils/cn"

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost' | 'danger'
  size?: 'default' | 'sm' | 'lg' | 'icon'
  isLoading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", isLoading, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={isLoading || disabled}
        className={cn(
          /*
           * `--radius-control` rather than `rounded-md`: a control and a panel
           * are different kinds of object and the foundation gives them
           * different corners, so a button never reads as a miniature card.
           *
           * The weight scale is the button hierarchy. `default` is the one
           * decisive action on a screen and is set in bold; the supporting
           * variants stay at semibold so a row of three buttons still has an
           * obvious first choice without a second colour being spent on it.
           */
          "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] text-sm font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:pointer-events-none disabled:opacity-50",
          {
            'bg-[var(--accent)] font-bold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)]': variant === 'default',
            'border border-[var(--border-strong)] bg-transparent text-[var(--text)] hover:border-[var(--text-muted)] hover:bg-[var(--surface-hover)]': variant === 'outline',
            'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]': variant === 'ghost',
            'bg-[var(--negative-soft)] text-[var(--negative)] hover:bg-[var(--negative-line)]': variant === 'danger',
            'h-10 px-4 py-2': size === 'default',
            'h-9 px-3': size === 'sm',
            'h-11 px-8': size === 'lg',
            'h-10 w-10': size === 'icon',
          },
          className
        )}
        {...props}
      >
        {isLoading ? <span className="animate-spin mr-2 border-2 border-current border-t-transparent rounded-full w-4 h-4" /> : null}
        {children}
      </button>
    )
  }
)
Button.displayName = "Button"

export { Button }
