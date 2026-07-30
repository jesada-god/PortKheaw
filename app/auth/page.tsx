import { redirect } from 'next/navigation';

/** `/auth` is a natural thing to type or link to; it opens the welcome screen. */
export default function AuthIndexPage() {
  redirect('/auth/welcome');
}
