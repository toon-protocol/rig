/**
 * Dual-shape kind:30618 ref parsing (rig#156, spec rig#153).
 *
 * The matrix: NIP-shape-only, legacy-only, both-agreeing, both-conflicting
 * (NIP wins), peeled `^{}` entries, the combined 1000-ref cap, and the real
 * ngit state event captured off `relay.ngit.dev` (rig#155).
 */

import { describe, it, expect } from 'vitest';

import {
  MAX_REFS_PER_EVENT,
  isNipRefTagName,
  parseStateRefTags,
} from './nip34-refs.js';
import { NGIT_STATE_NGIT } from './nip34-fixtures/index.js';

const SHA_A = '1a'.repeat(20);
const SHA_B = '2b'.repeat(20);
const SHA_C = '3c'.repeat(20);

describe('parseStateRefTags: tag shapes', () => {
  it('reads refs from the NIP-34 shape, where the ref path is the tag name', () => {
    const { refs, headSymref } = parseStateRefTags([
      ['d', 'demo'],
      ['refs/heads/main', SHA_A],
      ['refs/tags/v1.0.0', SHA_B],
      ['HEAD', 'ref: refs/heads/main'],
    ]);

    expect([...refs]).toEqual([
      ['refs/heads/main', SHA_A],
      ['refs/tags/v1.0.0', SHA_B],
    ]);
    expect(headSymref).toBe('refs/heads/main');
  });

  it('reads refs from the legacy r shape exactly as before', () => {
    const { refs, headSymref } = parseStateRefTags([
      ['d', 'demo'],
      ['r', 'refs/heads/main', SHA_A],
      ['r', 'refs/heads/dev', SHA_B],
      ['HEAD', 'ref: refs/heads/main'],
    ]);

    expect([...refs]).toEqual([
      ['refs/heads/main', SHA_A],
      ['refs/heads/dev', SHA_B],
    ]);
    expect(headSymref).toBe('refs/heads/main');
  });

  it('reads the alternate ["r", "HEAD", "ref: …"] symref spelling', () => {
    const { refs, headSymref } = parseStateRefTags([
      ['r', 'HEAD', 'ref: refs/heads/trunk'],
      ['r', 'refs/heads/trunk', SHA_A],
    ]);

    expect(headSymref).toBe('refs/heads/trunk');
    expect(refs.has('HEAD')).toBe(false);
  });

  it('merges both shapes into one ref set when they agree', () => {
    const { refs } = parseStateRefTags([
      ['refs/heads/main', SHA_A],
      ['r', 'refs/heads/main', SHA_A],
      ['r', 'refs/heads/dev', SHA_B],
      ['refs/tags/v2', SHA_C],
    ]);

    expect(refs.size).toBe(3);
    expect(refs.get('refs/heads/main')).toBe(SHA_A);
    expect(refs.get('refs/heads/dev')).toBe(SHA_B);
    expect(refs.get('refs/tags/v2')).toBe(SHA_C);
  });

  it('lets the NIP shape win a same-ref disagreement, whichever came first', () => {
    const nipFirst = parseStateRefTags([
      ['refs/heads/main', SHA_A],
      ['r', 'refs/heads/main', SHA_B],
    ]);
    expect(nipFirst.refs.get('refs/heads/main')).toBe(SHA_A);

    const legacyFirst = parseStateRefTags([
      ['r', 'refs/heads/main', SHA_B],
      ['refs/heads/main', SHA_A],
    ]);
    expect(legacyFirst.refs.get('refs/heads/main')).toBe(SHA_A);
  });

  it('ignores NIP-shape tags with no value and non-ref tag names', () => {
    const { refs } = parseStateRefTags([
      ['d', 'demo'],
      ['refs/heads/empty'],
      ['refs/notes/commits', SHA_A],
      ['--upload-pack=/evil', SHA_B],
      ['arweave', SHA_A, 'tx'],
      ['refs/heads/ok', SHA_C],
    ]);

    expect([...refs]).toEqual([['refs/heads/ok', SHA_C]]);
  });
});

describe('parseStateRefTags: peeled annotated tags', () => {
  it('does not list a peeled ^{} entry as a ref', () => {
    const { refs } = parseStateRefTags([
      ['refs/tags/v1.0.0', SHA_A],
      ['refs/tags/v1.0.0^{}', SHA_B],
    ]);

    expect([...refs]).toEqual([['refs/tags/v1.0.0', SHA_A]]);
    expect(refs.has('refs/tags/v1.0.0^{}')).toBe(false);
  });

  it('does not let peeled entries consume the ref cap', () => {
    const tags: string[][] = [];
    for (let i = 0; i < MAX_REFS_PER_EVENT; i += 1) {
      tags.push([`refs/tags/v${i}^{}`, SHA_A]);
    }
    tags.push(['refs/heads/main', SHA_B]);

    const { refs } = parseStateRefTags(tags);
    expect([...refs]).toEqual([['refs/heads/main', SHA_B]]);
  });
});

describe('parseStateRefTags: the 1000-ref cap', () => {
  it('caps DISTINCT refs across both shapes combined', () => {
    const tags: string[][] = [];
    for (let i = 0; i < 600; i += 1) tags.push([`refs/heads/n${i}`, SHA_A]);
    for (let i = 0; i < 600; i += 1)
      tags.push(['r', `refs/heads/l${i}`, SHA_B]);

    const { refs } = parseStateRefTags(tags);
    expect(refs.size).toBe(MAX_REFS_PER_EVENT);
    // The first 600 NIP-shape refs and the first 400 legacy ones got in.
    expect(refs.get('refs/heads/n599')).toBe(SHA_A);
    expect(refs.get('refs/heads/l399')).toBe(SHA_B);
    expect(refs.has('refs/heads/l400')).toBe(false);
  });

  it('does not let a dual-written event double the limit', () => {
    const tags: string[][] = [];
    for (let i = 0; i < MAX_REFS_PER_EVENT; i += 1) {
      tags.push([`refs/heads/b${i}`, SHA_A]);
      tags.push(['r', `refs/heads/b${i}`, SHA_A]);
    }

    const { refs } = parseStateRefTags(tags);
    expect(refs.size).toBe(MAX_REFS_PER_EVENT);
  });
});

describe('parseStateRefTags: hostile input is passed through, not blessed', () => {
  it('does not silently sanitize an unsafe refname in either shape', () => {
    // The refname gate lives at the git-invoking boundary (isSafeRefname in
    // clone/fetch/materialize), so BOTH shapes reach it identically — this
    // parser must not quietly drop one shape's hostile names and keep the
    // other's, which would make the two paths diverge.
    const hostile = 'refs/heads/../../../etc/passwd';
    const nip = parseStateRefTags([[hostile, SHA_A]]);
    const legacy = parseStateRefTags([['r', hostile, SHA_A]]);

    expect([...nip.refs]).toEqual([...legacy.refs]);
    expect(nip.refs.get(hostile)).toBe(SHA_A);
  });

  it('treats a short sha the same in both shapes', () => {
    const nip = parseStateRefTags([['refs/heads/main', 'abc123']]);
    const legacy = parseStateRefTags([['r', 'refs/heads/main', 'abc123']]);

    expect([...nip.refs]).toEqual([...legacy.refs]);
  });
});

describe('isNipRefTagName', () => {
  it('accepts refs/heads and refs/tags only', () => {
    expect(isNipRefTagName('refs/heads/main')).toBe(true);
    expect(isNipRefTagName('refs/tags/v1')).toBe(true);
    expect(isNipRefTagName('refs/notes/commits')).toBe(false);
    expect(isNipRefTagName('r')).toBe(false);
    expect(isNipRefTagName('HEAD')).toBe(false);
  });
});

describe('the real ngit state event (rig#155 capture)', () => {
  it('parses ngit’s own repo to its real branches and tags, peeled entries excluded', () => {
    const { refs, headSymref } = parseStateRefTags(NGIT_STATE_NGIT.tags);

    const branches = [...refs.keys()].filter((r) =>
      r.startsWith('refs/heads/')
    );
    const tags = [...refs.keys()].filter((r) => r.startsWith('refs/tags/'));

    expect(branches.sort()).toEqual([
      'refs/heads/main',
      'refs/heads/stable',
      'refs/heads/timeout-testing',
      'refs/heads/tmp',
    ]);
    expect(tags).toHaveLength(60);
    expect(refs.size).toBe(64);
    expect(headSymref).toBe('refs/heads/main');

    // The event carries 60 peeled entries; none of them is listed as a ref.
    expect(
      NGIT_STATE_NGIT.tags.filter((t) => (t[0] ?? '').endsWith('^{}'))
    ).toHaveLength(60);
    expect([...refs.keys()].some((r) => r.endsWith('^{}'))).toBe(false);

    // A peeled entry's sha never displaces its tag's own sha.
    expect(refs.get('refs/tags/v1.0.0')).not.toBe(
      '535be9c1c0a40fdeef9aa3ca84f90b01bc371a22'
    );
  });

  it('would have parsed zero refs under the legacy-only reader', () => {
    expect(NGIT_STATE_NGIT.tags.filter((t) => t[0] === 'r')).toEqual([]);
  });
});
