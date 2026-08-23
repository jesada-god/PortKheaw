/**
 * Next's boot hook. One job today: refuse to start on a database that cannot
 * store the labels this build writes.
 *
 * `register()` runs once per server instance, before the first request is
 * served, which is the only moment where "stop" is still cheaper than "serve
 * wrong". See `src/lib/analytics/options-signal/schema-guard.ts` for why the
 * CONFLICTED label specifically earns a hard stop where a missing table would
 * not: this failure is selective and silent, and it corrupts a baseline that is
 * still being built.
 *
 * Guarded on the Node runtime. `register()` also runs in the Edge runtime, where
 * `server-only` and the Supabase admin client do not belong, and a schema check
 * one process already made is not made better by an edge worker repeating it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertOptionsSignalSchemaReady } = await import(
    '@/src/lib/analytics/options-signal/schema-boot-guard'
  );
  await assertOptionsSignalSchemaReady();
}
