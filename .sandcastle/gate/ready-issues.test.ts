// The rules for which ready-for-agent issues the factory may start. The network
// lookups are injected; the rules themselves are what these tests pin down.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockersInBody,
  reasonToSkip,
  type IssueFacts,
  type Lookups,
} from '../ready-issues.ts';

function issue(over: Partial<IssueFacts> = {}): IssueFacts {
  return {
    number: 10,
    state: 'OPEN',
    body: '## What to build\n\nA thing.\n',
    labels: { nodes: [{ name: 'ready-for-agent' }] },
    subIssues: { totalCount: 0 },
    blockedBy: { nodes: [] },
    ...over,
  };
}

const lookups = (open: number[] = [], prs: number[] = []): Lookups => ({
  isOpen: (n) => open.includes(n),
  hasOpenPr: (n) => prs.includes(n),
});

describe('reasonToSkip', () => {
  it('starts an open, labelled ticket with no blocker and no PR', () => {
    assert.equal(reasonToSkip(issue(), lookups()), null);
  });

  it('skips a closed issue and one without the label', () => {
    assert.match(
      reasonToSkip(issue({ state: 'CLOSED' }), lookups())!,
      /not open/
    );
    assert.match(
      reasonToSkip(issue({ labels: { nodes: [] } }), lookups())!,
      /ready-for-agent/
    );
  });

  it('skips a spec, whether it has sub-issues or the to-spec template', () => {
    assert.match(
      reasonToSkip(issue({ subIssues: { totalCount: 2 } }), lookups())!,
      /spec/
    );
    assert.match(
      reasonToSkip(
        issue({ body: '## User Stories\n\n1. As a dev' }),
        lookups()
      )!,
      /to-spec/
    );
  });

  it('skips on an open native blocker but not on a closed one', () => {
    const blocked = issue({
      blockedBy: { nodes: [{ number: 3, state: 'OPEN' }] },
    });
    assert.match(reasonToSkip(blocked, lookups())!, /blocked by #3/);
    const cleared = issue({
      blockedBy: { nodes: [{ number: 3, state: 'CLOSED' }] },
    });
    assert.equal(reasonToSkip(cleared, lookups()), null);
  });

  it('skips on an open issue listed under ## Blocked by, not on a closed one', () => {
    const body = '## What\n\nx\n\n## Blocked by\n\n- #7\n- #8\n';
    assert.match(reasonToSkip(issue({ body }), lookups([8]))!, /blocked by #8/);
    assert.equal(reasonToSkip(issue({ body }), lookups([])), null);
  });

  it('skips when its branch already has an open PR', () => {
    assert.match(reasonToSkip(issue(), lookups([], [10]))!, /open PR/);
  });
});

describe('blockersInBody', () => {
  it('reads only the ## Blocked by section', () => {
    const body =
      'See #1.\n\n## Blocked by\n\n- #2\n- owner/repo#3\n\n## Other\n\n#4\n';
    assert.deepEqual(blockersInBody(body), [2]);
  });

  it('reads a section that runs to the end of the body', () => {
    assert.deepEqual(blockersInBody('## Blocked by\n\n- #5'), [5]);
  });

  it('finds nothing in "None"', () => {
    assert.deepEqual(
      blockersInBody('## Blocked by\n\n- None (can start immediately)\n'),
      []
    );
  });
});
