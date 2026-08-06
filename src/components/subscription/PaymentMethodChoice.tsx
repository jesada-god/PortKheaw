'use client';

import { useId, useState } from 'react';
import { CreditCard, QrCode } from 'lucide-react';
import { CheckoutButton } from './CheckoutButton';
import {
  PAYMENT_METHOD_COMMITMENT,
  PAYMENT_METHOD_LABEL,
  paymentMethodRenewalNote,
  promptPayDueWindowNote,
  type BillingPaymentMethod,
} from '@/src/lib/billing/billing-payment-method';
import type { PurchasePolicyVersions } from '@/src/lib/billing/purchase-consent';
import type { BillingInterval, BillingPlanKey } from '@/src/lib/billing/billing-plans';

/**
 * Choosing how to pay, before choosing what to press.
 *
 * The two rails are not interchangeable, so this is a choice a reader makes
 * knowingly rather than a payment option they discover on the provider's page: a
 * card renews by itself, PromptPay does not and never will. The selected rail's
 * commitment is stated under the buttons in the plan's own cadence — "ทุกเดือน"
 * on a monthly plan, "ทุกปี" on an annual one — because that is the sentence a
 * reader would otherwise only learn a month later when nothing renewed.
 *
 * The control sends a rail name and a plan key and nothing else. Both are
 * checked against closed allowlists on the server, which resolves the price, the
 * discount and the customer itself, so there is nothing here a modified client
 * could usefully change.
 */
export interface PurchasablePlan {
  key: BillingPlanKey;
  interval: BillingInterval;
  /** Already formatted; the amount itself never round-trips through the client. */
  label: string;
  emphasis: boolean;
}

const METHOD_ICON = { card: CreditCard, promptpay: QrCode } as const;

function sharedInterval(plans: readonly PurchasablePlan[]): BillingInterval | null {
  const first = plans[0]?.interval ?? null;
  return first && plans.every((plan) => plan.interval === first) ? first : null;
}

export function PaymentMethodChoice({ plans, methods, policyVersions }: {
  plans: readonly PurchasablePlan[];
  methods: readonly BillingPaymentMethod[];
  /** Published by the server; the consent step echoes them back on confirm. */
  policyVersions: PurchasePolicyVersions;
}) {
  const groupId = useId();
  const [selected, setSelected] = useState<BillingPaymentMethod>(methods[0] ?? 'card');
  // A rail that is no longer offered must not stay selected across a re-render.
  const method = methods.includes(selected) ? selected : methods[0] ?? 'card';

  return (
    <div className="min-w-0 space-y-3">
      {methods.length > 1 && (
        <fieldset className="min-w-0 space-y-2" data-testid="payment-method-choice">
          <legend className="text-xs font-semibold text-[var(--text-muted)]">
            เลือกวิธีชำระเงิน
          </legend>
          <div className="grid min-w-0 gap-2">
            {methods.map((option) => {
              const Icon = METHOD_ICON[option];
              const active = option === method;
              return (
                <label
                  key={option}
                  data-testid={`payment-method-${option}`}
                  data-selected={active}
                  className={[
                    'flex min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5',
                    'motion-safe:transition-colors',
                    'has-[:focus-visible]:outline has-[:focus-visible]:outline-2',
                    'has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus-ring)]',
                    active
                      ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]'
                      : 'border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name={`${groupId}-payment-method`}
                    value={option}
                    checked={active}
                    onChange={() => setSelected(option)}
                    className="sr-only"
                  />
                  <Icon
                    aria-hidden="true"
                    size={16}
                    className={`mt-0.5 shrink-0 ${active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold break-words text-[var(--text)]">
                      {PAYMENT_METHOD_LABEL[option]}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-[var(--text-muted)]">
                      {PAYMENT_METHOD_COMMITMENT[option]}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="min-w-0 space-y-2">
        {plans.map((plan) => (
          <CheckoutButton
            key={plan.key}
            planKey={plan.key}
            paymentMethod={method}
            emphasis={plan.emphasis}
            label={plan.label}
            policyVersions={policyVersions}
          />
        ))}
      </div>

      {/* The commitment, in the cadence of the plan being sold. An annual
          PromptPay subscriber scans once a year; a monthly one, twelve times —
          so the cadence is named only when every plan offered here shares one. */}
      <p data-testid="payment-method-note" className="text-xs leading-5 text-[var(--text-muted)]">
        {paymentMethodRenewalNote(method, sharedInterval(plans))}
        {method === 'promptpay' && ` · ${promptPayDueWindowNote()}`}
      </p>
    </div>
  );
}
