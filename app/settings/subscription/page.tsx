import { redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { AdminAccessCard } from '@/src/components/subscription/AdminAccessCard';
import { CurrentPlanHero } from '@/src/components/subscription/CurrentPlanHero';
import { ManageSubscriptionCard } from '@/src/components/subscription/ManageSubscriptionCard';
import { PendingInvoiceCard } from '@/src/components/subscription/PendingInvoiceCard';
import { PlanCards } from '@/src/components/subscription/PlanCards';
import { PlanComparison } from '@/src/components/subscription/PlanComparison';
import { SubscriptionFaq } from '@/src/components/subscription/SubscriptionFaq';
import { getBillingAvailability, getBillingConfig } from '@/src/lib/billing/billing-server';
import { readBillingSnapshot, readPendingPromptPayPayment } from '@/src/lib/billing/billing-repository';
import { holdsLiveSubscription, resolveBillingSummary } from '@/src/lib/billing/billing-summary';
import {
  pendingPromptPayIsOpen,
  resolvePendingPromptPayView,
} from '@/src/lib/billing/promptpay-pending';
import { isBillingPlanKey } from '@/src/lib/billing/billing-plans';
import { createClient } from '@/src/lib/supabase/server';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';
import { SubscriptionRepository } from '@/src/lib/subscription/repository';
import { resolveEffectiveTier } from '@/src/lib/subscription/resolve-effective-tier';
import { ADMIN_TRIAL_BLOCKED_MESSAGE, resolveTrialState } from '@/src/lib/subscription/trial';

/*
 * Entitlement state is per-reader and decided from the database clock, so this
 * page is never prerendered into shared HTML.
 */
export const dynamic = 'force-dynamic';

export default async function SubscriptionPage() {
  const supabase = await createClient();
  if (!supabase) {
    return (
      <>
        <Header title="แพ็กเกจของคุณ" />
        <div className="mx-auto max-w-2xl p-4 md:p-8"><ConfigurationRequired /></div>
      </>
    );
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in?next=/settings/subscription');

  const snapshot = await new SubscriptionRepository(supabase).getSnapshot();
  const effectiveTier = resolveEffectiveTier(snapshot, snapshot.databaseNow);
  /*
   * Mailbox confirmation is read from the verified user record on the server.
   * A client could otherwise claim it, and it is the gate on a one-per-account
   * grant.
   */
  const emailVerified = Boolean(user.email_confirmed_at);
  const trialState = resolveTrialState(snapshot, emailVerified);

  /*
   * Everything below the hero may know about the operator role and any running
   * preview. The hero and the plan cards deliberately do not: they describe the
   * subscription this account actually holds, which a preview must never
   * rewrite. That is what keeps "what am I paying for?" answerable while a
   * simulation is running.
   */
  const access = await resolveRequestAccountAccess();

  /*
   * Billing is read separately from the entitlement snapshot above, through the
   * database's own sanitized projection: it carries the plan, the period and the
   * payment state, and deliberately carries no provider customer, subscription,
   * price or invoice identifier. Whether anything can be *bought* is a property
   * of the deployment, not of the reader, and is resolved on the server so the
   * cards never have to guess.
   */
  const billingAvailability = getBillingAvailability({
    userId: access.userId,
    role: access.role,
  });
  const billingSnapshot = await readBillingSnapshot(supabase);
  const billingConfig = getBillingConfig();
  const snapshotMatchesMode = Boolean(
    billingConfig
    && billingSnapshot?.billing_provider_mode === billingConfig.providerMode,
  );
  const billingSummary = snapshotMatchesMode && billingSnapshot && resolveBillingSummary({
    tier: billingSnapshot.tier,
    status: billingSnapshot.status,
    planKey: billingSnapshot.billing_plan_key,
    cancelAtPeriodEnd: billingSnapshot.cancel_at_period_end,
    currentPeriodEnd: billingSnapshot.current_period_end,
    latestPaymentStatus: billingSnapshot.latest_payment_status,
    trialEndsAt: billingSnapshot.trial_ends_at,
    hasBillingCustomer: billingSnapshot.has_billing_customer,
    collectionMethod: billingSnapshot.billing_collection_method,
    // The database's clock, so a lapse reminder is never judged against a
    // browser's idea of the time.
    now: billingSnapshot.database_now,
  });

  /*
   * A PromptPay invoice that has been created and not paid. It grants nothing —
   * the tier still opens only from a paid invoice — so it is rendered as its own
   * card above the plans rather than as part of the subscription summary, and it
   * closes the purchase buttons for exactly as long as it can still be paid.
   */
  const pendingPayment = billingConfig
    ? await readPendingPromptPayPayment(supabase, billingConfig.providerMode)
    : null;
  /*
   * Judged against the database's clock and no other. An account with no billing
   * snapshot has no clock to judge by and no pending row to find, so it simply
   * has no card — never a deadline measured by whichever server rendered this.
   */
  const pendingView = pendingPayment
    && billingSnapshot
    && pendingPromptPayIsOpen(pendingPayment, billingSnapshot.database_now)
    ? resolvePendingPromptPayView({
      record: pendingPayment,
      now: billingSnapshot.database_now,
    })
    : null;
  const hasOpenInvoice = pendingView !== null;

  const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const metadataName = typeof user.user_metadata.full_name === 'string' ? user.user_metadata.full_name : null;
  const displayName = profile?.full_name || metadataName || user.email?.split('@')[0] || 'PortKheaw User';

  return (
    <div className="min-w-0">
      <Header title="แพ็กเกจของคุณ" subtitle="ดูสิทธิ์ปัจจุบัน และเลือกแพ็กเกจที่เหมาะกับพอร์ตของคุณ" />
      <main className="mx-auto flex max-w-5xl min-w-0 flex-col gap-8 p-4 md:p-8">
        <CurrentPlanHero
          state={trialState}
          effectiveTier={effectiveTier}
          trialBlockedReason={access.isAdmin ? ADMIN_TRIAL_BLOCKED_MESSAGE : undefined}
        />
        {pendingView && <PendingInvoiceCard view={pendingView} />}
        {billingSummary && <ManageSubscriptionCard summary={billingSummary} />}
        {access.isAdmin && <AdminAccessCard access={access} name={displayName} />}
        <PlanCards
          effectiveTier={effectiveTier}
          availability={billingAvailability}
          /*
           * The same predicates the checkout action gates on, so the cards
           * cannot offer a purchase the server would refuse.
           */
          hasLiveSubscription={snapshotMatchesMode && holdsLiveSubscription({
            status: billingSnapshot?.status ?? 'basic',
            planKey: isBillingPlanKey(billingSnapshot?.billing_plan_key)
              ? billingSnapshot.billing_plan_key
              : null,
            collectionMethod: billingSnapshot?.billing_collection_method ?? null,
            currentPeriodEnd: billingSnapshot?.current_period_end ?? null,
            now: billingSnapshot?.database_now ?? null,
          })}
          hasOpenInvoice={hasOpenInvoice}
        />
        <PlanComparison />
        <SubscriptionFaq billingEnabled={billingAvailability.enabled} />
      </main>
    </div>
  );
}
