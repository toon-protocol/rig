/**
 * Factory job protocol — reproducible gate result per increment (#53).
 *
 * Decision 5 of toon-meta#262 splits trust into three layers: delivery (the
 * hashlock), the objective floor (this — "did this increment pass the
 * repo's own gate?"), and quality (reputation, out of scope here). Per
 * `FACTORY.md`, the pinned pipeline's gate is lint/typecheck/test/build run
 * before a PR is opened; this module is the pure, network-free shape for
 * recording exactly what ran, not a summary verdict.
 *
 * This proves conformance, not fitness for purpose — a gate-passing
 * increment can still completely miss the brief. Reputation is what
 * distinguishes those, never this.
 */

/** One command the gate ran, and whether it passed. */
export interface GateCheck {
  /** e.g. "lint", "typecheck", "test", "build" — whatever actually ran,
   * never a canonical list (gates differ per repo and drift over time). */
  name: string;
  /** The literal command, e.g. "eslint .", so a buyer can reproduce it verbatim. */
  command: string;
  pass: boolean;
}

/**
 * A reproducible gate result: enough for a buyer to re-run the gate
 * themselves and get the same answer. Omitting the commit or the command
 * set turns this from a reproducible result into a provider's unverifiable
 * claim of having done well — both are required, not advisory.
 */
export interface GateResult {
  /** The commit this gate ran against. */
  commit: string;
  /** Toolchain versions relevant to reproducing the result, e.g. `{ node: "20.11.0", pnpm: "9.1.0" }`. */
  toolchain: Record<string, string>;
  checks: GateCheck[];
}

/** Overall pass/fail — every recorded check passed. A failing gate is not a protocol violation (it is still published, just visibly failing) — this is only the aggregate the `gate` tag and reputation's gate-pass rate read. */
export function gatePassed(gate: GateResult): boolean {
  return gate.checks.every((check) => check.pass);
}
