import { resolveReleaseAnnouncement } from '@/src/lib/release-notes/release-notes-server';
import { ReleaseAnnouncement } from './ReleaseAnnouncement';

/**
 * Resolves the announcement on the server and renders nothing when there is not
 * one — which is the overwhelmingly common case, so the popup's client bundle is
 * never sent to a reader who has nothing to be told.
 *
 * Deliberately not a client fetch. A browser asking "have I seen this?" would be
 * a browser that can be told the wrong answer, and would put the query on the
 * critical path of every page view.
 */
export async function ReleaseAnnouncementGate() {
  const announcement = await resolveReleaseAnnouncement();
  if (!announcement) return null;
  return <ReleaseAnnouncement {...announcement} publishedAt={announcement.publishedAt} />;
}
