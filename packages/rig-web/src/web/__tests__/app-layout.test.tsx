import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { describe, it, expect } from 'vitest';
import { AppLayout } from '@/app/app-layout';

describe('[P0] AppLayout', () => {
  it('renders the routed view with no chrome above it', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<div>routed view</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('routed view')).toBeInTheDocument();
    // The branding header is gone: no banner landmark, no title, no toggle.
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByText('The Rig')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Toggle theme' }),
    ).not.toBeInTheDocument();
  });
});
