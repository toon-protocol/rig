/**
 * Pubkey identity utilities for @toon-protocol/rig-web.
 *
 * Stub: Will be implemented as part of the rig epic.
 * Maps Nostr pubkeys to git author identities and checks maintainer authorization.
 */

import { authorizedAuthors } from '@toon-protocol/rig/repo-authority';

export interface AuthorizationResult {
  authorized: boolean;
  rejectCode?: string;
  rejectMessage?: string;
}

export interface GitAuthorIdentity {
  name: string;
  email: string;
  env: {
    GIT_AUTHOR_NAME: string;
    GIT_AUTHOR_EMAIL: string;
  };
}

export interface PubkeyProfile {
  displayName: string;
  picture?: string;
  isEnriched: boolean;
}

/**
 * Checks whether a pubkey is authorized as a maintainer based on a
 * kind:30617 repository announcement event.
 */
export function checkMaintainerAuthorization(
  pubkey: string,
  repoEvent: { pubkey: string; tags: string[][] }
): AuthorizationResult {
  const authorized = authorizedAuthors(repoEvent.pubkey, repoEvent.tags);
  if (authorized.has(pubkey.toLowerCase())) return { authorized: true };
  return {
    authorized: false,
    rejectCode: 'F06',
    rejectMessage:
      'Unauthorized: pubkey is not a maintainer of this repository',
  };
}

/**
 * Converts a Nostr pubkey to a git author identity.
 */
export function toGitAuthorIdentity(_pubkey: string): GitAuthorIdentity {
  throw new Error('toGitAuthorIdentity is not yet implemented');
}

/**
 * Enriches a pubkey with profile data from kind:0 events.
 * Falls back to truncated npub on failure.
 */
export async function enrichPubkeyProfile(
  _pubkey: string,
  _options: { relayClient: unknown }
): Promise<PubkeyProfile> {
  throw new Error('enrichPubkeyProfile is not yet implemented');
}
