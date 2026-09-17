import { formatByteSize } from '../job-log.js';
import type { CiLogTail } from '../nip-c1-parsers.js';

/**
 * What the live view is, said once and in the same words everywhere it is
 * shown (rig#194, ADR-0002): a rolling tail, replaced on the coordinator's
 * cadence, never the record. Output that scrolled past between two
 * refreshes is not here and cannot be recovered live — it is in the job log
 * a minute later, and the page must not let a viewer believe otherwise.
 */
export const LIVE_TAIL_DISCLAIMER =
  'A rolling live view, replaced as the run proceeds — not the record. ' +
  'Output that scrolled past between refreshes is not shown here; the job ' +
  'log published when the run concludes is the complete record.';

/**
 * One live channel's recent output: a job's tail, or the runner channel.
 *
 * `label` is what the channel is called on screen, `note` says what it is,
 * and the omitted-bytes footer names what precedes the tail — a viewer is
 * never shown a tail without being told what it is a tail of.
 */
export function LiveTailPane({
  label,
  note,
  channel,
  empty,
  testId,
}: {
  label: string;
  note: string;
  channel: CiLogTail;
  empty: string;
  testId: string;
}) {
  return (
    <section data-testid={testId} className="rounded-md border">
      <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <span className="font-semibold text-foreground">{label}</span>
        <span className="text-muted-foreground">{note}</span>
      </header>
      <pre className="max-h-[32rem] overflow-auto bg-muted/20 p-4 font-mono text-xs leading-relaxed text-foreground">
        {channel.tail || empty}
      </pre>
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">
        {channel.omittedBytes > 0 &&
          `${formatByteSize(channel.omittedBytes)} of earlier output comes before this tail. `}
        {LIVE_TAIL_DISCLAIMER}
      </p>
    </section>
  );
}

/**
 * The runner channel of a run in flight: container cleanup after a timeout,
 * an image pull that failed, backend output belonging to no job.
 *
 * It is deliberately NOT a job card and carries no job state badge — it has
 * no Job Result and never concludes, so presenting it as a job would make
 * every run look like it contained an extra job that never finishes.
 */
export function RunnerChannelPane({ channel }: { channel: CiLogTail }) {
  return (
    <LiveTailPane
      testId="runner-channel"
      label="Runner"
      note="the runner talking about this run — not a job, and it never concludes"
      channel={channel}
      empty="(the runner has said nothing)"
    />
  );
}
