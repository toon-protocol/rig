/**
 * Workflow discovery and trigger matching (rig#125).
 *
 * Workflows are GitHub-Actions-syntax files the coordinator reads out of a
 * MATERIALIZED checkout (never from the relay, never from GitHub): first
 * `.github/workflows/*.yml|yaml`, then `.ngit/act/workflows/*.yml|yaml` so
 * repos already on ngit CI are served as-is. Each is identified on every
 * NIP-C1 event by its path and the SHA-256 of its bytes (the `w` tag), so a
 * consumer can verify exactly which file ran.
 *
 * Only the `on:` clause and the job list are interpreted here — enough to
 * decide WHETHER a workflow runs for a push/pull-request trigger and which
 * job ids to expect. Everything else in the file is act's business
 * (./act-runner.ts). Parsing never throws: a malformed file comes back with
 * `parseError` set so the coordinator can publish an honest
 * `startup_failure` for it instead of silently skipping it.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Where workflows live, in scan order (relative to the checkout root). */
export const WORKFLOW_DIRS = ['.github/workflows', '.ngit/act/workflows'] as const;

const WORKFLOW_FILE_RE = /\.ya?ml$/i;

/** Branch/tag filters of a `push:` or `pull_request:` trigger. */
export interface RefFilters {
  branches?: string[];
  tags?: string[];
}

export interface WorkflowTriggers {
  push?: RefFilters;
  pull_request?: RefFilters;
  workflow_dispatch?: boolean;
}

export interface WorkflowJob {
  id: string;
  name?: string;
  runsOn?: string[];
}

export interface DiscoveredWorkflow {
  /** Path relative to the checkout root, forward slashes. */
  path: string;
  /** Lowercase hex SHA-256 of the file's exact bytes. */
  sha256: string;
  name?: string;
  triggers: WorkflowTriggers;
  jobs: WorkflowJob[];
  /** Set when the file could not be understood; `triggers`/`jobs` are then empty. */
  parseError?: string;
}

/** Lowercase hex SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return undefined;
}

function refFilters(value: unknown): RefFilters {
  if (!isRecord(value)) return {};
  const out: RefFilters = {};
  const branches = stringList(value['branches']);
  const tags = stringList(value['tags']);
  if (branches) out.branches = branches;
  if (tags) out.tags = tags;
  return out;
}

/** Interpret every GitHub shape of `on:` (string, list, map). */
function parseTriggers(on: unknown): WorkflowTriggers {
  const triggers: WorkflowTriggers = {};
  const enable = (name: unknown, options: unknown): void => {
    if (name === 'push') triggers.push = refFilters(options);
    else if (name === 'pull_request') triggers.pull_request = refFilters(options);
    else if (name === 'workflow_dispatch') triggers.workflow_dispatch = true;
  };
  if (typeof on === 'string') enable(on, undefined);
  else if (Array.isArray(on)) for (const name of on) enable(name, undefined);
  else if (isRecord(on)) {
    for (const [name, options] of Object.entries(on)) enable(name, options);
  }
  return triggers;
}

function parseJobs(jobs: unknown): WorkflowJob[] {
  if (!isRecord(jobs)) return [];
  const out: WorkflowJob[] = [];
  for (const [id, spec] of Object.entries(jobs)) {
    const job: WorkflowJob = { id };
    if (isRecord(spec)) {
      if (typeof spec['name'] === 'string') job.name = spec['name'];
      const runsOn = stringList(spec['runs-on']);
      if (runsOn) job.runsOn = runsOn;
    }
    out.push(job);
  }
  return out;
}

/**
 * Parse one workflow file's bytes. Never throws — see the module header.
 * YAML 1.1 loaders read the unquoted `on` key as boolean `true`; the `yaml`
 * package (YAML 1.2) keeps it a string, but a file re-saved by such a loader
 * carries a literal `true:` key, so both spellings are honoured.
 */
export function parseWorkflow(path: string, content: string | Uint8Array): DiscoveredWorkflow {
  const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf-8');
  const base: DiscoveredWorkflow = {
    path,
    sha256: sha256Hex(content),
    triggers: {},
    jobs: [],
  };
  let doc: unknown;
  try {
    doc = parseYaml(text, { strict: false, uniqueKeys: false });
  } catch (err) {
    return { ...base, parseError: err instanceof Error ? err.message : String(err) };
  }
  if (!isRecord(doc)) {
    return { ...base, parseError: 'workflow is not a YAML mapping' };
  }
  const on = doc['on'] ?? doc['true'];
  if (on === undefined || on === null) {
    return { ...base, parseError: 'workflow has no `on:` trigger clause' };
  }
  const out = { ...base, triggers: parseTriggers(on), jobs: parseJobs(doc['jobs']) };
  if (typeof doc['name'] === 'string') out.name = doc['name'];
  return out;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Every workflow file under {@link WORKFLOW_DIRS} in `checkoutDir`, in a
 * stable order (directory order, then filename). Missing directories are
 * simply empty.
 */
export async function discoverWorkflows(checkoutDir: string): Promise<DiscoveredWorkflow[]> {
  const found: DiscoveredWorkflow[] = [];
  for (const dir of WORKFLOW_DIRS) {
    let names: string[];
    try {
      names = await readdir(join(checkoutDir, dir));
    } catch {
      continue;
    }
    for (const name of names.filter((n) => WORKFLOW_FILE_RE.test(n)).sort()) {
      const rel = `${dir}/${name}`;
      const bytes = await readFile(join(checkoutDir, dir, name));
      found.push(parseWorkflow(rel, bytes));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Trigger matching (GitHub filter-pattern semantics)
// ---------------------------------------------------------------------------

/**
 * Compile one GitHub filter pattern: `*` matches within a path segment,
 * `**` matches across segments, `?` one character, `+` one or more of the
 * preceding character; everything else is literal.
 */
function patternToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '+') {
      re += '+';
    } else {
      re += ch.replace(/[.\\^$|()[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * GitHub's `branches`/`tags` filter rule: patterns are applied in order, a
 * `!` pattern excludes, and a name is included only if the LAST matching
 * pattern was positive. A negation can never include on its own.
 */
export function refMatchesPatterns(shortName: string, patterns: string[]): boolean {
  let included = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    if (patternToRegExp(body).test(shortName)) included = !negated;
  }
  return included;
}

/**
 * Does `wf` run for a push that moved `ref` (`refs/heads/...` or
 * `refs/tags/...`)? Mirrors GitHub: no filters → every ref; a `branches`
 * filter alone → only branches; a `tags` filter alone → only tags.
 */
export function matchesPush(wf: DiscoveredWorkflow, ref: string): boolean {
  if (wf.parseError !== undefined || !wf.triggers.push) return false;
  const { branches, tags } = wf.triggers.push;
  if (!branches && !tags) return true;
  if (ref.startsWith('refs/heads/')) {
    return branches !== undefined && refMatchesPatterns(ref.slice('refs/heads/'.length), branches);
  }
  if (ref.startsWith('refs/tags/')) {
    return tags !== undefined && refMatchesPatterns(ref.slice('refs/tags/'.length), tags);
  }
  return false;
}

/**
 * Does `wf` run for a pull request against `baseRef` (a `refs/heads/...` ref
 * or a bare branch name)? With a `branches` filter and no known base the
 * match cannot be proven, so the workflow does not run.
 */
export function matchesPullRequest(wf: DiscoveredWorkflow, baseRef?: string): boolean {
  if (wf.parseError !== undefined || !wf.triggers.pull_request) return false;
  const { branches } = wf.triggers.pull_request;
  if (!branches) return true;
  if (baseRef === undefined) return false;
  const short = baseRef.startsWith('refs/heads/') ? baseRef.slice('refs/heads/'.length) : baseRef;
  return refMatchesPatterns(short, branches);
}
