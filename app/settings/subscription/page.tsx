import { redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';
import { CurrentPlanHero } from '@/src/components/subscription/CurrentPlanHero';
import { PlanCards } from '@/src/components/subscription/PlanCards';
import { PlanComparison } from '@/src/components/subscription/PlanComparison';
import { SubscriptionFaq } from '@/src/components/subscription/SubscriptionFaq';
import { createClient } from '@/src/lib/supabase/server';
import { SubscriptionRepository } from '@/src/lib/subscription/repository';
import { resolveEffectiveTier } from '@/src/lib/subscription/resolve-effective-tier';
import { resolveTrialState } from '@/src/lib/subscription/trial';

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

  return (
    <div className="min-w-0">
      <Header title="แพ็กเกจของคุณ" subtitle="ดูสิทธิ์ปัจจุบัน และเลือกแพ็กเกจที่เหมาะกับพอร์ตของคุณ" />
      <main className="mx-auto flex max-w-5xl min-w-0 flex-col gap-8 p-4 md:p-8">
        <CurrentPlanHero state={trialState} effectiveTier={effectiveTier} />
        <PlanCards effectiveTier={effectiveTier} />
        <PlanComparison />
        <SubscriptionFaq />
      </main>
    </div>
  );
}
