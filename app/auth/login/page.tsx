import { redirect } from 'next/navigation';
import { getSafeReturnPath } from '@/src/lib/auth/paths';

/**
 * `/auth/login` is what people type, bookmark, and link to; the form itself
 * lives at `/auth/sign-in`. Answering the common spelling with a 404 is
 * indistinguishable, from the outside, from "the sign-in page is broken" — so
 * the alias forwards to the real page instead.
 *
 * The `next` value is rebuilt through {@link getSafeReturnPath} rather than
 * passed along verbatim, so the alias cannot become a redirect gadget that
 * carries a visitor off this origin.
 */
export default async function LoginAliasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = getSafeReturnPath(typeof params.next === 'string' ? params.next : null);
  redirect(`/auth/sign-in?next=${encodeURIComponent(next)}`);
}
