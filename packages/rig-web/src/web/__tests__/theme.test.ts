import { describe, it, expect, beforeEach } from 'vitest';
import { applyPreferredTheme, preferredTheme } from '@/theme';

/** A minimal Window stand-in: just the three surfaces theme.ts touches. */
function fakeWin(opts: {
  stored?: string | null;
  prefersDark?: boolean;
  throwOnStorage?: boolean;
}): Window {
  const classes = new Set<string>();
  return {
    localStorage: {
      getItem: () => {
        if (opts.throwOnStorage) throw new Error('blocked');
        return opts.stored ?? null;
      },
    },
    matchMedia: () => ({ matches: opts.prefersDark ?? false }),
    document: {
      documentElement: {
        classList: {
          toggle: (name: string, on: boolean) => {
            if (on) classes.add(name);
            else classes.delete(name);
          },
          contains: (name: string) => classes.has(name),
        },
      },
    },
  } as unknown as Window;
}

describe('[P1] boot theme', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('prefers a stored choice over the system preference', () => {
    expect(preferredTheme(fakeWin({ stored: 'dark', prefersDark: false }))).toBe('dark');
    expect(preferredTheme(fakeWin({ stored: 'light', prefersDark: true }))).toBe('light');
  });

  it('falls back to the system preference when nothing is stored', () => {
    expect(preferredTheme(fakeWin({ prefersDark: true }))).toBe('dark');
    expect(preferredTheme(fakeWin({ prefersDark: false }))).toBe('light');
  });

  it('ignores an unreadable localStorage instead of throwing', () => {
    expect(preferredTheme(fakeWin({ throwOnStorage: true, prefersDark: true }))).toBe('dark');
  });

  it('puts `dark` on <html> for dark and takes it off for light', () => {
    const dark = fakeWin({ stored: 'dark' });
    expect(applyPreferredTheme(dark)).toBe('dark');
    expect(dark.document.documentElement.classList.contains('dark')).toBe(true);

    const light = fakeWin({ stored: 'light' });
    expect(applyPreferredTheme(light)).toBe('light');
    expect(light.document.documentElement.classList.contains('dark')).toBe(false);
  });
});
