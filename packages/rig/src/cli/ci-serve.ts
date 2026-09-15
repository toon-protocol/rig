// placeholder — slice E replaces this file
/**
 * `rig ci serve` — the coordinator loop (#125). This placeholder keeps the
 * tree typechecking while the coordinator slice lands; it is replaced
 * wholesale by the real implementation.
 */

import type { CiDeps } from './ci.js';

export const CI_SERVE_USAGE = `Usage: rig ci serve --relay <ws-url> --repo <owner>/<repo-id> [options]

Run a CI coordinator (not implemented yet in this build).`;

export async function runCiServe(
  _args: string[],
  deps: CiDeps
): Promise<number> {
  deps.io.err('rig ci serve: not implemented');
  return 1;
}
