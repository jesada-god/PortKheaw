import * as React from 'react';
import { cn } from '@/src/utils/cn';

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, label, onCheckedChange, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-slot="switch"
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'box-border inline-grid h-11 w-14 flex-none grid-cols-2 items-center rounded-full border p-1 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] hover:border-[var(--accent-hover)]'
          : 'border-[var(--border-strong)] bg-[var(--input-bg)] hover:border-[var(--text-muted)]',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-6 w-6 rounded-full transition-[background-color,transform]',
          checked
            ? 'col-start-2 justify-self-end bg-[var(--accent)]'
            : 'col-start-1 justify-self-start bg-[var(--text-muted)]',
        )}
      />
    </button>
  ),
);
Switch.displayName = 'Switch';

export { Switch };
