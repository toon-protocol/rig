/**
 * Theme application at boot.
 *
 * Tailwind's dark variant keys off a `dark` class on `<html>`, and nothing else
 * puts it there — this used to live inside the header's theme toggle, so when
 * the header went the whole dark mode would have gone with it. Applying the
 * stored-or-system choice here keeps dark mode working with no UI attached to
 * it, and keeps honouring a `rig-theme` value left behind by the old toggle.
 */

type Theme = 'light' | 'dark';

/** The viewer's stored choice, else what their OS asks for. */
export function preferredTheme(win: Window = window): Theme {
  try {
    const stored = win.localStorage.getItem('rig-theme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage unavailable (private window, blocked site data)
  }
  return win.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** Put the preferred theme on `<html>`; safe to call before React mounts. */
export function applyPreferredTheme(win: Window = window): Theme {
  const theme = preferredTheme(win);
  win.document.documentElement.classList.toggle('dark', theme === 'dark');
  return theme;
}
