import { useMemo } from 'react';
import { useRigConfig } from './use-rig-config.js';
import { useRelay } from './use-relay.js';
import { commentBelongsToThread, parseComment } from '../nip34-parsers.js';
import { buildCommentFilters } from '../relay-client.js';
import type { CommentMetadata, NostrFilter } from '../nip34-parsers.js';

interface UseCommentsResult {
  comments: CommentMetadata[];
  loading: boolean;
  error: Error | null;
}

/**
 * A thread's comments: NIP-22 kind:1111 (matched on the UPPERCASE `E` root
 * scope) merged with rig's legacy kind:1622 dialect, in `createdAt` order, so
 * a thread reads as one conversation regardless of which client wrote each
 * comment (rig#159). The two kinds need two filters — see
 * {@link buildCommentFilters} — hence two fixed relay subscriptions.
 */
export function useComments(eventIds: string[]): UseCommentsResult {
  const { relayUrl } = useRigConfig();

  const [nip22Filter, legacyFilter] = useMemo<
    [NostrFilter | null, NostrFilter | null]
  >(() => {
    if (eventIds.length === 0) return [null, null];
    const [nip22, legacy] = buildCommentFilters(eventIds);
    return [nip22 ?? null, legacy ?? null];
  }, [eventIds]);

  const nip22 = useRelay(relayUrl, nip22Filter);
  const legacy = useRelay(relayUrl, legacyFilter);

  const comments = useMemo(() => {
    const parsed: CommentMetadata[] = [];
    const seen = new Set<string>();
    for (const ev of [...nip22.events, ...legacy.events]) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      // Membership re-checked client-side: the relay is permissionless, so a
      // kind:1111 whose only match is a lowercase `e` must not slip into
      // someone else's thread.
      if (!eventIds.some((rootId) => commentBelongsToThread(ev, rootId))) {
        continue;
      }
      const comment = parseComment(ev);
      if (comment) parsed.push(comment);
    }
    return parsed.sort((a, b) => a.createdAt - b.createdAt);
  }, [nip22.events, legacy.events, eventIds]);

  return {
    comments,
    loading: nip22.loading || legacy.loading,
    error: nip22.error ?? legacy.error,
  };
}
