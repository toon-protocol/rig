import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { npubToHex } from '../npub.js';
import {
  parseHonoredRepoRefs,
  parseRepoAnnouncement,
  repoAuthorizedAuthors,
} from '../nip34-parsers.js';
import { buildRepoRefsFilter } from '../relay-client.js';
import { honoredRepoState } from '@toon-protocol/rig/repo-authority';
import type { RepoMetadata, RepoRefs, NostrFilter } from '../nip34-parsers.js';

interface UseRepoResult {
  metadata: RepoMetadata | null;
  refs: RepoRefs | null;
  loading: boolean;
  error: Error | null;
}

export function useRepo(owner: string, repo: string): UseRepoResult {
  const { relayUrl } = useRigConfig();

  const ownerHex = useMemo(() => {
    try {
      return owner.startsWith('npub1') ? npubToHex(owner) : owner;
    } catch {
      return null;
    }
  }, [owner]);

  const repoFilter = useMemo<NostrFilter | null>(() => {
    if (!ownerHex) return null;
    return { kinds: [30617], authors: [ownerHex], '#d': [repo] };
  }, [ownerHex, repo]);

  const {
    events: repoEvents,
    loading: repoLoading,
    error: repoError,
  } = useRelay(relayUrl, repoFilter);

  // The owner's latest announcement (ADR-0005): newest wins, lowest id on a tie.
  const metadata = useMemo(() => {
    if (!ownerHex) return null;
    const latest = honoredRepoState(
      new Set([ownerHex.toLowerCase()]),
      repoEvents
    );
    return latest ? (parseRepoAnnouncement(latest) ?? null) : null;
  }, [ownerHex, repoEvents]);

  // Refs come from the authorized authors (owner + the owner's announced
  // maintainers, ADR-0005), so the owner's announcement is fetched first.
  const authorized = useMemo(() => {
    if (!ownerHex) return null;
    const owned =
      metadata && metadata.ownerPubkey.toLowerCase() === ownerHex.toLowerCase();
    return owned
      ? repoAuthorizedAuthors(metadata)
      : new Set([ownerHex.toLowerCase()]);
  }, [ownerHex, metadata]);

  const refsFilter = useMemo<NostrFilter | null>(() => {
    if (!authorized || repoLoading) return null;
    return buildRepoRefsFilter([...authorized].sort(), repo);
  }, [authorized, repoLoading, repo]);

  const {
    events: refsEvents,
    loading: refsLoading,
    error: refsError,
  } = useRelay(relayUrl, refsFilter);

  const refs = useMemo(
    () =>
      authorized ? parseHonoredRepoRefs(refsEvents, authorized, repo) : null,
    [refsEvents, authorized, repo]
  );

  return {
    metadata,
    refs,
    loading: repoLoading || refsLoading || (!!ownerHex && !refsFilter),
    error: repoError || refsError,
  };
}
