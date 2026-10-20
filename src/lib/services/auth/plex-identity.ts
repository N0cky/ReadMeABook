/**
 * Component: Plex Login Identity Checks
 * Documentation: documentation/backend/services/auth.md
 *
 * A Plex sign-in writes the user row keyed by the Plex identity (plexId). That identity
 * always comes from Plex (account lookup or the Plex Home user list), never from the
 * request, and it may only ever land on a Plex user's row.
 */

import { prisma } from '@/lib/db';

/** Plex ids are numeric account ids or Plex uuids; local logins use `local-<name>`. */
export function isPlexIdentity(plexId: unknown): plexId is string {
  return (
    typeof plexId === 'string' &&
    plexId.length > 0 &&
    plexId.length <= 128 &&
    /^[A-Za-z0-9-]+$/.test(plexId) &&
    !plexId.toLowerCase().startsWith('local-')
  );
}

/**
 * True when a Plex sign-in may create or update the row for this plexId: the id looks like
 * a Plex id, and any existing row with it is a Plex user (authProvider 'plex' or unset),
 * never a local or OIDC account.
 */
export async function canSignInAsPlexIdentity(plexId: unknown): Promise<boolean> {
  if (!isPlexIdentity(plexId)) return false;
  const existing = await prisma.user.findUnique({
    where: { plexId },
    select: { authProvider: true },
  });
  return !existing || existing.authProvider === null || existing.authProvider === undefined || existing.authProvider === 'plex';
}
