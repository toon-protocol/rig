import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router';
import { normalizeRelayFragment } from '@/relay-fragment';
import { applyPreferredTheme } from '@/theme';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RigConfigProvider } from '@/hooks/use-rig-config';
import { ProfileCacheProvider } from '@/hooks/use-profile-cache';
import { AppLayout } from '@/app/app-layout';
import { RepoLayout } from '@/app/repo-layout';
import { RepoListPage } from '@/app/pages/repo-list-page';
import { ProfilePage } from '@/app/pages/profile-page';
import { RepoHomePage } from '@/app/pages/repo-home-page';
import { TreePage } from '@/app/pages/tree-page';
import { BlobPage } from '@/app/pages/blob-page';
import { CommitLogPage } from '@/app/pages/commit-log-page';
import { CommitDetailPage } from '@/app/pages/commit-detail-page';
import { BlamePage } from '@/app/pages/blame-page';
import { IssueListPage } from '@/app/pages/issue-list-page';
import { IssueDetailPage } from '@/app/pages/issue-detail-page';
import { PRListPage } from '@/app/pages/pr-list-page';
import { PRDetailPage } from '@/app/pages/pr-detail-page';
import { ActionsPage } from '@/app/pages/actions-page';
import { RunDetailPage } from '@/app/pages/run-detail-page';
import { JobDetailPage } from '@/app/pages/job-detail-page';
import { NotFoundPage } from '@/app/pages/not-found-page';
import './globals.css';

// The documented shareable form is `#relay=wss://…`, but HashRouter owns
// the fragment — rewrite it to the router-safe `#/?relay=…` BEFORE the
// router mounts, or the app blank-pages on an unmatched route.
normalizeRelayFragment();

// Tailwind's dark variant needs a `dark` class on <html>; no UI sets it since
// the header went, so apply the stored-or-system choice before the first paint.
applyPreferredTheme();

const root = document.getElementById('app');
if (!root) throw new Error('Root element #app not found');

createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <TooltipProvider>
        <RigConfigProvider>
          <ProfileCacheProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route index element={<RepoListPage />} />
                {/* Bare owner (npub/hex) — the user profile page (kind:0
                    metadata + their repos). More specific `:owner/:repo`
                    routes below still win by React Router's ranking. */}
                <Route path=":owner" element={<ProfilePage />} />
                <Route path=":owner/:repo" element={<RepoLayout />}>
                  <Route index element={<RepoHomePage />} />
                  <Route path="tree/:ref/*" element={<TreePage />} />
                  <Route path="blob/:ref/*" element={<BlobPage />} />
                  {/* Bare /commits (GitHub-style URL, no branch) resolves the
                      default branch — previously it matched NO route and the
                      whole app white-screened (#277). */}
                  <Route path="commits" element={<CommitLogPage />} />
                  <Route path="commits/:ref" element={<CommitLogPage />} />
                  <Route path="commit/:sha" element={<CommitDetailPage />} />
                  <Route path="blame/:ref/*" element={<BlamePage />} />
                  <Route path="issues" element={<IssueListPage />} />
                  <Route path="issues/:id" element={<IssueDetailPage />} />
                  <Route path="pulls" element={<PRListPage />} />
                  <Route path="pulls/:id" element={<PRDetailPage />} />
                  {/* Actions (rig#125): NIP-C1 workflow runs, per repo and per run. */}
                  <Route path="actions" element={<ActionsPage />} />
                  <Route path="actions/:runId" element={<RunDetailPage />} />
                  {/* One job of a run (rig#190). Addressed by the run id and
                      the job id — both fixed for the life of the run, so the
                      link survives exactly as ADR-0001 asks of rig-web URLs. */}
                  <Route
                    path="actions/:runId/jobs/:jobId"
                    element={<JobDetailPage />}
                  />
                </Route>
                {/* Catch-all: unmatched URLs render an inline card with the
                    header intact instead of an empty page (#277). */}
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </ProfileCacheProvider>
        </RigConfigProvider>
      </TooltipProvider>
    </HashRouter>
  </StrictMode>,
);
