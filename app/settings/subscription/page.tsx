import { redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { AdminAccessCard } from '@/src/components/subscription/AdminAccessCard';
import { CurrentPlanHero } from '@/src/components/subscription/CurrentPlanHero';
import { ManageSubscriptionCard } from '@/src/components/subscription/ManageSubscriptionCard';
import { PlanCards } from '@/src/components/subscription/PlanCards';
import { PlanComparison } from '@/src/components/subscription/PlanComparison';
import { SubscriptionFaq } from '@/src/components/subscription/SubscriptionFaq';
import { getBillingAvailability } from '@/src/lib/billing/billing-server';
import { readBillingSnapshot } from '@/src/lib/billing/billing-repository';
import { holdsLiveSubscription, resolveBillingSummary } from '@/src/lib/billing/billing-summary';
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
  const billingAvailability = getBillingAvailability();
  const billingSnapshot = await readBillingSnapshot(supabase);
  const billingSummary = billingSnapshot && resolveBillingSummary({
    tier: billingSnapshot.tier,
    status: billingSnapshot.status,
    planKey: billingSnapshot.billing_plan_key,
    cancelAtPeriodEnd: billingSnapshot.cancel_at_period_end,
    currentPeriodEnd: billingSnapshot.current_period_end,
    latestPaymentStatus: billingSnapshot.latest_payment_status,
    trialEndsAt: billingSnapshot.trial_ends_at,
    hasBillingCustomer: billingSnapshot.has_billing_customer,
  });

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
        {billingSummary && <ManageSubscriptionCard summary={billingSummary} />}
        {access.isAdmin && <AdminAccessCard access={access} name={displayName} />}
        <PlanCards
          effectiveTier={effectiveTier}
          availability={billingAvailability}
          /*
           * The same predicate the checkout action gates on, so the cards cannot
           * offer a purchase the server would refuse.
           */
          hasLiveSubscription={holdsLiveSubscription({
            status: billingSnapshot?.status ?? 'basic',
            planKey: isBillingPlanKey(billingSnapshot?.billing_plan_key)
              ? billingSnapshot.billing_plan_key
              : null,
          })}
        />
        <PlanComparison />
        <SubscriptionFaq billingEnabled={billingAvailability.enabled} />
      </main>
    </div>
  );
}
