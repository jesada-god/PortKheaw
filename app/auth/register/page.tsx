import { redirect } from 'next/navigation';
import { getSafeReturnPath } from '@/src/lib/auth/paths';

/** The `/auth/sign-up` counterpart of the `/auth/login` alias. */
export default async function RegisterAliasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = getSafeReturnPath(typeof params.next === 'string' ? params.next : null);
  redirect(`/auth/sign-up?next=${encodeURIComponent(next)}`);
}
