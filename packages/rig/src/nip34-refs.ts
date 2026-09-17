/**
 * Repository-state ref parsing for kind:30618 (spec rig#153, ticket rig#156).
 *
 * ONE parser shared by every rig-side reader of a repository state event —
 * the CLI's remote-state reader (`./remote-state.ts`, behind `rig clone` and
 * `rig fetch`) and the CI Coordinator's push watcher
 * (`./ci/coordinator.ts`), whose commit materialization reads the refs it
 * produces. `@toon-protocol/rig-web` cannot import this module (it is only a
 * DEVELOPMENT dependency of that package, resolved through a `dist/` that
 * does not exist when the repo's typecheck gate runs), so it keeps a
 * documented COPY of this logic in `nip34-parsers.ts` — the same
 * "copy rather than depend, and say so" pattern as `gateway-preference.ts`
 * and the ngit wire fixtures. Both are tested against the same captured ngit
 * events (`./nip34-fixtures/`).
 *
 * TWO ref tag shapes are accepted:
 *
 *  - **NIP-34 shape** — `["refs/heads/main", "<sha>"]`. The ref path IS the
 *    tag name. This is what NIP-34 specifies and what ngit, gitworkshop.dev
 *    and the rest of the ecosystem write.
 *  - **Legacy rig shape** — `["r", "refs/heads/main", "<sha>"]`. rig's own
 *    spelling, still written during the dual-write window (rig#157) and read
 *    forever after, so every repo pushed before rig#153 stays clonable.
 *
 * The rules, all from rig#153's Implementation Decisions:
 *
 *  - A tag is a NIP-shape ref when its name starts with `refs/heads/` or
 *    `refs/tags/`. Nothing else in the NIP shape is read as a ref, so a
 *    hostile relay cannot smuggle a bare `["--upload-pack=…", …]` in as one.
 *  - A NIP-shape name ending in `^{}` is a PEELED annotated tag (ngit emits
 *    these for `git fetch --prune`). It is not a ref and is not listed.
 *  - When both shapes name the same ref with DIFFERENT shas, **the NIP shape
 *    wins**, whichever came first in tag order — so two rig versions reading
 *    the same event can never silently disagree.
 *  - {@link MAX_REFS_PER_EVENT} caps DISTINCT refs across both shapes
 *    combined, so a dual-written event cannot double the limit. The NIP shape
 *    also gets FIRST CLAIM on those slots: each shape is collected on its own
 *    and the two are merged NIP-first, so which refs survive a >1000-ref
 *    event never depends on the order a writer (or a hostile relay) happened
 *    to interleave the two shapes in.
 *
 * What this parser deliberately does NOT do is validate. Refname safety
 * (`isSafeRefname`, ./materialize.ts) and full-SHA checks live at the
 * git-invoking boundary, where they apply to every ref regardless of which
 * tag shape carried it — so the NIP shape is not a hostile-relay bypass, and
 * stays byte-for-byte as strict as the `r` shape it joins.
 *
 * See `docs/nip34-wire-shapes.md` for the full kind:30618 wire contract,
 * including the dual-write end condition and the object-map (`arweave` tag)
 * cap. Where the two disagree, this file's actual code is the ground
 * truth.
 */

/**
 * Maximum number of DISTINCT refs parsed from a single kind:30618 event,
 * counted across both tag shapes combined.
 */
export const MAX_REFS_PER_EVENT = 1000;

/** Symref prefix used in `HEAD` tags: `["HEAD", "ref: refs/heads/main"]`. */
const SYMREF_PREFIX = 'ref: ';

/** Tag-name prefixes that make a NIP-34-shaped tag a ref. */
const NIP_REF_PREFIXES = ['refs/heads/', 'refs/tags/'] as const;

/** Suffix marking a peeled annotated-tag entry: `refs/tags/v1.0.0^{}`. */
const PEELED_SUFFIX = '^{}';

/**
 * Is this tag NAME a NIP-34-shaped ref path? True for `refs/heads/…` and
 * `refs/tags/…`, including the peeled `^{}` spellings — {@link
 * parseStateRefTags} drops those separately.
 */
function isNipRefTagName(name: string): boolean {
  return NIP_REF_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Merge the two shapes' refs into one map: NIP shape first, so it both wins
 * every same-ref disagreement and takes first claim on the cap's slots;
 * legacy refs fill whatever remains.
 */
function mergeShapes(
  nip: Map<string, string>,
  legacy: Map<string, string>
): Map<string, string> {
  const refs = new Map([...nip].slice(0, MAX_REFS_PER_EVENT));
  for (const [refname, sha] of legacy) {
    if (refs.size >= MAX_REFS_PER_EVENT) break;
    if (nip.has(refname)) continue;
    refs.set(refname, sha);
  }
  return refs;
}

/** Refs and the HEAD symref read out of one kind:30618 event's tags. */
export interface ParsedStateRefs {
  /** Refname → commit sha, capped at {@link MAX_REFS_PER_EVENT} distinct refs. */
  refs: Map<string, string>;
  /** HEAD symref target (e.g. `refs/heads/main`), or null when unset. */
  headSymref: string | null;
}

/**
 * Parse the ref and `HEAD` tags of a kind:30618 repository state event,
 * accepting the NIP-34 shape and rig's legacy `r` shape together. See the
 * module header for the conflict, peeled-tag and cap rules.
 *
 * `arweave` tags are NOT read here — they are an object-location map, not
 * ref state, and each caller handles them itself.
 */
export function parseStateRefTags(tags: string[][]): ParsedStateRefs {
  // Each shape is staged on its own, then merged NIP-first (see mergeShapes).
  // Both staging maps are themselves bounded, so a relay that serves a
  // million ref tags costs bounded memory, not a million entries.
  const nip = new Map<string, string>();
  const legacy = new Map<string, string>();
  let headSymref: string | null = null;

  for (const tag of tags) {
    const [name, v1, v2] = tag;
    if (name === undefined) continue;

    if (name === 'r' && v1 && v2) {
      if (v1 === 'HEAD' && v2.startsWith(SYMREF_PREFIX)) {
        // Alternate symref spelling: ["r", "HEAD", "ref: refs/heads/main"]
        headSymref = v2.slice(SYMREF_PREFIX.length);
        continue;
      }
      if (legacy.size < MAX_REFS_PER_EVENT || legacy.has(v1)) {
        legacy.set(v1, v2);
      }
      continue;
    }

    if (name === 'HEAD' && v1?.startsWith(SYMREF_PREFIX)) {
      // NIP-34 symref tag: ["HEAD", "ref: refs/heads/main"]
      headSymref = v1.slice(SYMREF_PREFIX.length);
      continue;
    }

    if (v1 && isNipRefTagName(name) && !name.endsWith(PEELED_SUFFIX)) {
      // NIP-34 ref tag: ["refs/heads/main", "<sha>"]
      if (nip.size < MAX_REFS_PER_EVENT || nip.has(name)) nip.set(name, v1);
    }
  }

  return { refs: mergeShapes(nip, legacy), headSymref };
}
