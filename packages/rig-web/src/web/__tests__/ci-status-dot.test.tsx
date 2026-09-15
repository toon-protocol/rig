import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect } from 'vitest';
import {
  CiStatusDot,
  conclusionBadgeClass,
  describeRunState,
} from '@/components/ci-status-dot';
import type { CiRun } from '../nip-c1-parsers.js';

function run(overrides: Partial<CiRun> = {}): CiRun {
  return {
    runId: 'run-1',
    coordinator: '12'.repeat(32),
    trigger: {
      repoAddr: `30617:${'ab'.repeat(32)}:demo`,
      commit: '9a'.repeat(20),
      workflow: { path: '.github/workflows/ci.yml', sha256: 'f0'.repeat(32) },
      reason: 'push',
      ref: 'refs/heads/main',
    },
    status: 'concluded',
    conclusion: 'success',
    inProgress: [],
    createdAt: 1700,
    jobs: [],
    trust: 'maintainer-directed',
    current: true,
    ...overrides,
  };
}

function renderDot(runs: CiRun[]) {
  return render(
    <MemoryRouter>
      <CiStatusDot runs={runs} owner="npub1owner" repo="demo" />
    </MemoryRouter>
  );
}

describe('[P1] CiStatusDot', () => {
  it('renders nothing for a commit with no runs', () => {
    const { container } = renderDot([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('is green and links to the single run page when one run passed', () => {
    renderDot([run()]);
    const link = screen.getByRole('link', { name: 'CI passing' });
    expect(link).toHaveAttribute('href', '/npub1owner/demo/actions/run-1');
    expect(link).toHaveAttribute('data-ci-status', 'success');
    expect(link.getAttribute('title')).toContain(
      '.github/workflows/ci.yml: success'
    );
  });

  it('is red when any run failed, and links to the Actions tab for several runs', () => {
    renderDot([run(), run({ runId: 'run-2', conclusion: 'timed_out' })]);
    const link = screen.getByRole('link', { name: 'CI failing' });
    expect(link).toHaveAttribute('href', '/npub1owner/demo/actions');
    expect(link.getAttribute('title')).toContain('2 runs');
    expect(link.getAttribute('title')).toContain('timed out');
  });

  it('pulses yellow while a run is still in progress', () => {
    renderDot([
      run({
        status: 'in_progress',
        conclusion: undefined,
        inProgress: ['build'],
      }),
    ]);
    const link = screen.getByRole('link', { name: 'CI in progress' });
    expect(link).toHaveAttribute('data-ci-status', 'pending');
    expect(link.querySelector('span')?.className).toContain('animate-pulse');
  });

  it('describes run states and picks badge classes by outcome', () => {
    expect(describeRunState({ status: 'queued' })).toBe('queued');
    expect(
      describeRunState({ status: 'concluded', conclusion: 'startup_failure' })
    ).toBe('startup failure');
    expect(conclusionBadgeClass('concluded', 'success')).toContain('success');
    expect(conclusionBadgeClass('concluded', 'failure')).toContain(
      'destructive'
    );
    expect(conclusionBadgeClass('queued', undefined)).toContain('yellow');
  });
});
