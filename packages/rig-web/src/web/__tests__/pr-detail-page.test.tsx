/**
 * PRDetailPage revisions (#230): the page shows the latest authorized
 * revision by default and lets the visitor browse earlier ones via `?rev=`.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { RepoContext } from '@/app/repo-layout';
import type { PRMetadata } from '../nip34-parsers.js';

vi.mock('@/hooks/use-prs', () => ({ usePRs: vi.fn() }));
vi.mock('@/hooks/use-ci-runs', () => ({
  useCiRuns: () => ({
    runsForPr: () => [],
    runsForCommit: () => [],
  }),
}));
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({ comments: [], loading: false }),
}));
vi.mock('@/hooks/use-commit-detail', () => ({
  useCommitDetail: vi.fn(() => ({
    commit: null,
    changedFiles: [],
    loading: false,
  })),
}));
vi.mock('@/hooks/use-profile-cache', () => ({
  useProfileCache: () => ({
    getDisplayName: (pk: string) => `user-${pk.slice(0, 4)}`,
    requestProfiles: vi.fn(),
    version: 0,
  }),
}));

import { PRDetailPage } from '@/app/pages/pr-detail-page';
import { usePRs } from '@/hooks/use-prs';
import { useCommitDetail } from '@/hooks/use-commit-detail';

const mockUsePRs = vi.mocked(usePRs);
const mockUseCommitDetail = vi.mocked(useCommitDetail);

afterEach(() => cleanup());

const AUTHOR = 'cd'.repeat(32);
const MAINT = 'ef'.repeat(32);
const ROOT = '55'.repeat(32);
const REV2 = '66'.repeat(32);

const CONTEXT: RepoContext = {
  metadata: {
    repoId: 'demo',
    name: 'demo',
    description: '',
    ownerPubkey: 'ab'.repeat(32),
    defaultBranch: 'main',
    eventId: 'evt',
    cloneUrls: [],
    webUrls: [],
    maintainers: [],
  },
  refs: null,
  owner: 'npub1owner',
  repo: 'demo',
};

const PR: PRMetadata = {
  eventId: ROOT,
  title: 'Second try',
  content: 'content v2',
  authorPubkey: AUTHOR,
  createdAt: 1,
  commitShas: ['sha2'],
  baseBranch: 'main',
  status: 'open',
  sourceKind: 1617,
  revisions: [
    {
      eventId: ROOT,
      authorPubkey: AUTHOR,
      createdAt: 1,
      title: 'First try',
      content: 'content v1',
      commitShas: ['sha1'],
      baseBranch: 'main',
    },
    {
      eventId: REV2,
      authorPubkey: MAINT,
      createdAt: 2,
      title: 'Second try',
      content: 'content v2',
      commitShas: ['sha2'],
      baseBranch: 'main',
    },
  ],
};

function renderAt(search = '', id = ROOT) {
  return render(
    <MemoryRouter initialEntries={[`/npub1owner/demo/pulls/${id}${search}`]}>
      <Routes>
        <Route element={<Outlet context={CONTEXT} />}>
          <Route path="/:owner/:repo/pulls/:id" element={<PRDetailPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockUsePRs.mockReturnValue({ prs: [PR], loading: false, error: null });
  mockUseCommitDetail.mockClear();
});

describe('PRDetailPage revisions', () => {
  it('shows the latest authorized revision by default', () => {
    renderAt();
    expect(screen.getByText('Second try')).toBeTruthy();
    expect(screen.queryByText('First try')).toBeNull();
    expect(mockUseCommitDetail.mock.calls[0]?.[0]).toBe('sha2');
  });

  it('links to earlier revisions', () => {
    renderAt();
    const link = screen.getByRole('link', { name: 'v1' });
    expect(link.getAttribute('href')).toContain(`rev=${ROOT}`);
  });

  it('shows an earlier revision when asked', () => {
    renderAt(`?rev=${ROOT}`);
    expect(screen.getByText('First try')).toBeTruthy();
    expect(screen.getByText(/earlier revision/)).toBeTruthy();
    expect(mockUseCommitDetail.mock.calls[0]?.[0]).toBe('sha1');
  });

  it('ignores a ?rev that is not an authorized revision', () => {
    renderAt(`?rev=${'99'.repeat(32)}`);
    expect(screen.getByText('Second try')).toBeTruthy();
  });

  it("opens a revision's id on its root's page, showing the latest", () => {
    renderAt('', REV2);
    expect(screen.getByText('Second try')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'v1' })).toBeTruthy();
  });

  it('credits the opening comment to the revision shown', () => {
    renderAt();
    expect(screen.getAllByText(`user-${MAINT.slice(0, 4)}`).length).toBeGreaterThan(0);
    cleanup();
    renderAt(`?rev=${ROOT}`);
    expect(screen.queryByText(`user-${MAINT.slice(0, 4)}`)).toBeNull();
  });
});
