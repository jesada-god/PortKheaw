import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { LegalFooterLinks } from '@/src/components/legal/LegalFooterLinks';
import { BillingHistoryCard } from '@/src/components/refunds/BillingHistoryCard';
import { listMyBillingInvoices } from '@/src/lib/support/refund-repository';
import { AdminAccessCard } from '@/src/components/subscription/AdminAccessCard';
import { BetaWaitlistCard } from '@/src/components/subscription/BetaWaitlistCard';
import { CheckoutReturnFunnel } from '@/src/components/subscription/CheckoutReturnFunnel';
import { CurrentPlanHero } from '@/src/components/subscription/CurrentPlanHero';
import { ManageSubscriptionCard } from '@/src/components/subscription/ManageSubscriptionCard';
import { PendingInvoiceCard } from '@/src/components/subscription/PendingInvoiceCard';
import { PlanCards } from '@/src/components/subscription/PlanCards';
import { PlanComparison } from '@/src/components/subscription/PlanComparison';
import { SubscriptionFaq } from '@/src/components/subscription/SubscriptionFaq';
import { getBillingAvailability, getBillingConfig } from '@/src/lib/billing/billing-server';
import { readBillingSnapshot, readPendingPromptPayPayment } from '@/src/lib/billing/billing-repository';
import {
  holdsLiveSubscription,
  holdsReusablePromptPaySubscription,
  resolveBillingSummary,
} from '@/src/lib/billing/billing-summary';
import {
  pendingPromptPayIsOpen,
  resolvePendingPromptPayView,
} from '@/src/lib/billing/promptpay-pending';
import { isBillingPlanKey } from '@/src/lib/billing/billing-plans';
import { createClient } from '@/src/lib/supabase/server';
import { recordBetaFunnelEvent, resolveBetaAccessForRequest } from '@/src/lib/beta/beta-server';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';
import { SubscriptionRepository } from '@/src/lib/subscription/repository';
import { resolveEffectiveTier } from '@/src/lib/subscription/resolve-effective-tier';
import { resolveTrialState } from '@/src/lib/subscription/trial';
import { resolveTrialEligibility } from '@/src/lib/trial-identity/trial-eligibility';

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
   * The one eligibility service, asked once per render and cached for the rest
   * of it. It is what makes the hero's note and the action's refusal the same
   * sentence — including the one a reader sees on a fresh account whose mailbox
   * already spent its free week on an account they deleted.
   */
  const trialEligibility = await resolveTrialEligibility();
  const trialBlockedReason = trialEligibility.ok ? undefined : trialEligibility.message;

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
  const storedPlanKey = isBillingPlanKey(billingSnapshot?.billing_plan_key)
    ? billingSnapshot.billing_plan_key
    : null;
  const blocksNewCheckout = snapshotMatchesMode && (
    holdsLiveSubscription({
      status: billingSnapshot?.status ?? 'basic',
      planKey: storedPlanKey,
      collectionMethod: billingSnapshot?.billing_collection_method ?? null,
      currentPeriodEnd: billingSnapshot?.current_period_end ?? null,
      now: billingSnapshot?.database_now ?? null,
    })
    || holdsReusablePromptPaySubscription({
      status: billingSnapshot?.status ?? 'basic',
      planKey: storedPlanKey,
      collectionMethod: billingSnapshot?.billing_collection_method ?? null,
    })
  );

  /*
   * The controlled rollout, resolved once for this render. The plan cards and
   * the checkout action read the same answer — the action re-asks the database,
   * so what is *shown* and what is *authorized* cannot drift apart.
   *
   * Only new purchases are gated. The hero, the manage card, the pending invoice,
   * the billing history and the FAQ are rendered in every stage, because every
   * one of them belongs to a reader who has already paid.
   */
  const beta = await resolveBetaAccessForRequest();

  /*
   * The funnel, recorded from the server where the fact is already known.
   *
   * `payment_succeeded` is deliberately observed here rather than in the webhook:
   * the webhook runs as the service role with no session, so a row written there
   * could not be attributed to an account at all. Recording "this account holds a
   * live paid subscription" on the first page view after paying is both
   * attributable and true — and the report counts distinct accounts, so a
   * subscriber visiting daily is still one conversion.
   *
   * None of these is awaited for its result; each is deduplicated inside the
   * database, and a funnel row is never worth failing a page render over.
   *
   * `checkout_returned` and `checkout_canceled` are deliberately *not* here.
   * They are carried by the provider's return URL, and this page must never read
   * a query parameter — the billing security contract asserts that, because a
   * page anybody can type into an address bar must not be able to grant
   * anything. `CheckoutReturnFunnel` records them from the browser instead, and
   * the routine it calls can only ever insert a telemetry row.
   */
  await Promise.all([
    recordBetaFunnelEvent({ event: 'subscription_viewed' }),
    billingSummary && blocksNewCheckout
      ? recordBetaFunnelEvent({
        event: 'payment_succeeded',
        planKey: storedPlanKey,
        paymentRail: billingSnapshot?.billing_collection_method === 'send_invoice' ? 'promptpay' : 'card',
      })
      : null,
    /*
     * The PromptPay renewal funnel, as two halves of one question: a reader on
     * that rail with an invoice still open is looking at *how to pay it*, and the
     * same reader with no open invoice and a live period has paid. Recording both
     * for every PromptPay reader would make the conversion read as 100% and
     * measure nothing.
     */
    billingSnapshot?.billing_collection_method === 'send_invoice' && hasOpenInvoice
      ? recordBetaFunnelEvent({ event: 'promptpay_renewal_help_viewed', paymentRail: 'promptpay' })
      : null,
    billingSummary
      && blocksNewCheckout
      && billingSnapshot?.billing_collection_method === 'send_invoice'
      && !hasOpenInvoice
      ? recordBetaFunnelEvent({ event: 'promptpay_renewal_paid', paymentRail: 'promptpay' })
      : null,
  ]);

  const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const metadataName = typeof user.user_metadata.full_name === 'string' ? user.user_metadata.full_name : null;
  const displayName = profile?.full_name || metadataName || user.email?.split('@')[0] || 'PortKheaw User';

  return (
    <div className="min-w-0">
      <Header title="แพ็กเกจของคุณ" subtitle="ดูสิทธิ์ปัจจุบัน และเลือกแพ็กเกจที่เหมาะกับพอร์ตของคุณ" />
      <main className="mx-auto flex max-w-5xl min-w-0 flex-col gap-8 p-4 md:p-8">
        {/* Renders nothing. It observes the provider's checkout return so this
            page never has to read a query parameter. */}
        <Suspense fallback={null}><CheckoutReturnFunnel /></Suspense>
        <CurrentPlanHero
          state={trialState}
          effectiveTier={effectiveTier}
          /*
           * Why the trial is off the table for somebody the snapshot alone would
           * call eligible — an operator, a reader the rollout has not admitted,
           * or somebody whose identity is already in the persistent ledger. The
           * sentence comes from the same service the action calls, so the note
           * under the inert button is the answer the button would have given.
           * This hides a button; it does not authorize anything.
           */
          trialBlockedReason={trialBlockedReason}
        />
        {pendingView && <PendingInvoiceCard view={pendingView} />}
        {billingSummary && (
          <ManageSubscriptionCard
            summary={billingSummary}
            pendingPromptPayUrl={pendingView?.hostedInvoiceUrl ?? null}
            hasOpenPromptPayInvoice={hasOpenInvoice}
          />
        )}
        {access.isAdmin && <AdminAccessCard access={access} name={displayName} />}
        {/*
          Outside the active rollout stage the plan cards are replaced rather than
          disabled: a row of buttons that all refuse is worse than one sentence
          saying why. `PlanComparison` stays either way — knowing what the plans
          contain is useful to somebody waiting for an invitation.
        */}
        {beta.admitted ? (
          <PlanCards
            effectiveTier={effectiveTier}
            /*
             * Availability already carries the deployment's own answer (billing
             * off, or no price configured). The rollout is the second gate, and
             * the branch above is where it applies — so the cards never have to
             * know a stage exists.
             */
            availability={billingAvailability}
            /*
             * The same predicates the checkout action gates on, so the cards
             * cannot offer a purchase the server would refuse.
             */
            hasLiveSubscription={blocksNewCheckout}
            hasOpenInvoice={hasOpenInvoice}
          />
        ) : (
          <BetaWaitlistCard reason={beta.reason} stage={beta.stage} />
        )}
        <PlanComparison />
        {/*
         * Purchases, and the way into a refund request. Read through the
         * reader's own session with the sanitized projection, so the card can
         * show what was paid without a provider identifier reaching the browser.
         */}
        <BillingHistoryCard invoices={await listMyBillingInvoices(supabase)} />
        <SubscriptionFaq billingEnabled={billingAvailability.enabled} />
        <LegalFooterLinks />
      </main>
    </div>
  );
}
