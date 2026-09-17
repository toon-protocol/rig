/**
 * Reading a job log back (rig#190).
 *
 * The job log is the durable record of one job: the Coordinator uploads it to
 * the store and names it in the Job Result's `logs` tag. Rendering it is the
 * first time anything in this repo reads one back, and the blob at the other
 * end of that URL was written by whichever Coordinator ran the job — not
 * necessarily one that bounds what it uploads (ADR-0003 bounds rig's, and
 * says nothing about anyone else's). A page that trusted the blob to be small
 * would hand a viewer's browser an unbounded download the moment they clicked
 * a job.
 *
 * So the read stops at its OWN ceiling, and the caller is told that it did,
 * together with the blob's declared size where the gateway gives one — a
 * truncated log must never pass for the whole story. The body is consumed a
 * chunk at a time and the stream is cancelled at the ceiling, so the bytes
 * past it are never pulled over the wire.
 */

/**
 * How much of a job log this client will read. ADR-0003 caps what rig's
 * Coordinator uploads at 1 MiB, so a log it wrote always arrives whole with
 * room to spare; a foreign blob stops here.
 */
export const JOB_LOG_CEILING_BYTES = 2 * 1024 * 1024;

export interface JobLog {
  /** The bytes that were read, decoded as UTF-8. */
  text: string;
  bytesRead: number;
  /** True when the read stopped at the ceiling with bytes still to come. */
  truncated: boolean;
  /** The blob's full size, when the gateway declared a `Content-Length`. */
  totalBytes?: number;
}

export interface ReadJobLogOptions {
  /** Defaults to {@link JOB_LOG_CEILING_BYTES}. */
  ceilingBytes?: number;
  signal?: AbortSignal;
  /** Injected for tests; defaults to the browser's `fetch`. */
  fetchImpl?: typeof fetch;
}

function declaredLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Fetch a job log, reading at most `ceilingBytes` of it.
 *
 * Rejects when the gateway refuses (the status is in the message): a log that
 * cannot be fetched is an error, but a job with no log at all is not — that
 * case never reaches here, because the Job Result carries no `logs` tag.
 */
export async function readJobLog(
  url: string,
  options: ReadJobLogOptions = {}
): Promise<JobLog> {
  const ceiling = options.ceilingBytes ?? JOB_LOG_CEILING_BYTES;
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `The store returned ${response.status} ${response.statusText} for this job log`
    );
  }
  const totalBytes = declaredLength(response);
  const decoder = new TextDecoder('utf-8');
  const body = response.body;

  // No streaming body (an old browser, a test double): take what arrived and
  // apply the ceiling to it, so the pane is bounded even when the download
  // was not.
  if (!body) {
    const all = new Uint8Array(await response.arrayBuffer());
    const kept = all.byteLength > ceiling ? all.subarray(0, ceiling) : all;
    return {
      text: decoder.decode(kept),
      bytesRead: kept.byteLength,
      truncated: all.byteLength > ceiling,
      totalBytes: totalBytes ?? all.byteLength,
    };
  }

  const reader = body.getReader();
  let text = '';
  let bytesRead = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    const room = ceiling - bytesRead;
    // A chunk arrived with no room left, or more than the room left: the blob
    // goes on past the ceiling. Take what fits and let the rest go.
    if (value.byteLength > room) {
      if (room > 0) {
        text += decoder.decode(value.subarray(0, room), { stream: true });
        bytesRead += room;
      }
      truncated = true;
      await reader.cancel();
      break;
    }
    text += decoder.decode(value, { stream: true });
    bytesRead += value.byteLength;
  }
  text += decoder.decode();
  return {
    text,
    bytesRead,
    truncated,
    ...(totalBytes !== undefined ? { totalBytes } : {}),
  };
}

const UNITS: readonly [number, string][] = [
  [1024 * 1024 * 1024, 'GiB'],
  [1024 * 1024, 'MiB'],
  [1024, 'KiB'],
];

/** A byte count as a viewer reads it: `9.4 MiB`, `512 B`. */
export function formatByteSize(bytes: number): string {
  for (const [scale, unit] of UNITS) {
    if (bytes >= scale) {
      const value = bytes / scale;
      const rounded =
        value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
      return `${rounded} ${unit}`;
    }
  }
  return `${Math.round(bytes)} B`;
}
