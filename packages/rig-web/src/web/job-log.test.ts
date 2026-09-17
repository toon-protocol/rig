import { describe, it, expect, vi } from 'vitest';
import {
  JOB_LOG_CEILING_BYTES,
  formatByteSize,
  readJobLog,
} from './job-log.js';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface FakeResponseOptions {
  status?: number;
  contentLength?: string | null;
  /** Serve the body in one gulp (no stream), as an old browser would. */
  noStream?: boolean;
  onCancel?: () => void;
}

/**
 * A gateway response. `chunks` arrive one read at a time so a test can see
 * how far the reader got before it stopped.
 */
function fakeResponse(chunks: string[], opts: FakeResponseOptions = {}) {
  const all = bytes(chunks.join(''));
  const headers = new Map<string, string>();
  const declared =
    opts.contentLength === undefined
      ? String(all.byteLength)
      : opts.contentLength;
  if (declared !== null) headers.set('content-length', declared);
  const body = opts.noStream
    ? null
    : new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(bytes(chunk));
          controller.close();
        },
        cancel() {
          opts.onCancel?.();
        },
      });
  return {
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    statusText: 'Test',
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body,
    arrayBuffer: () => Promise.resolve(all.buffer),
  } as unknown as Response;
}

const URL_ = 'https://gateway.test/raw/tx-log';

describe('[P1] readJobLog (rig#190)', () => {
  it('reads a whole job log when it fits under the ceiling', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(fakeResponse(['hello ', 'world']))
    );
    const log = await readJobLog(URL_, { fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledWith(URL_, expect.anything());
    expect(log.text).toBe('hello world');
    expect(log.truncated).toBe(false);
    expect(log.bytesRead).toBe(11);
    expect(log.totalBytes).toBe(11);
  });

  it('stops at the ceiling and says so, with the blob size the gateway declared', async () => {
    const onCancel = vi.fn();
    const fetchImpl = () =>
      Promise.resolve(fakeResponse(['aaaa', 'bbbb', 'cccc'], { onCancel }));
    const log = await readJobLog(URL_, {
      fetchImpl: fetchImpl as never,
      ceilingBytes: 6,
    });
    expect(log.text).toBe('aaaabb');
    expect(log.bytesRead).toBe(6);
    expect(log.truncated).toBe(true);
    expect(log.totalBytes).toBe(12);
    // The rest of the blob is never pulled over the wire.
    expect(onCancel).toHaveBeenCalled();
  });

  it('is truncated with no total when the gateway declares no length', async () => {
    const fetchImpl = () =>
      Promise.resolve(fakeResponse(['aaaa', 'bbbb'], { contentLength: null }));
    const log = await readJobLog(URL_, {
      fetchImpl: fetchImpl as never,
      ceilingBytes: 4,
    });
    expect(log.text).toBe('aaaa');
    expect(log.truncated).toBe(true);
    expect(log.totalBytes).toBeUndefined();
  });

  it('a body exactly at the ceiling is whole, not truncated', async () => {
    const fetchImpl = () => Promise.resolve(fakeResponse(['abcd']));
    const log = await readJobLog(URL_, {
      fetchImpl: fetchImpl as never,
      ceilingBytes: 4,
    });
    expect(log.text).toBe('abcd');
    expect(log.truncated).toBe(false);
  });

  it('still honours the ceiling when the response cannot be streamed', async () => {
    const fetchImpl = () =>
      Promise.resolve(fakeResponse(['abcdefgh'], { noStream: true }));
    const log = await readJobLog(URL_, {
      fetchImpl: fetchImpl as never,
      ceilingBytes: 3,
    });
    expect(log.text).toBe('abc');
    expect(log.truncated).toBe(true);
    expect(log.totalBytes).toBe(8);
  });

  it('decodes multi-byte characters split across chunk boundaries', async () => {
    // "é" is two bytes; the fake serves it whole, but the decoder must be
    // streaming for a chunk boundary mid-character not to corrupt it.
    const fetchImpl = () => Promise.resolve(fakeResponse(['caf', 'é ok']));
    const log = await readJobLog(URL_, { fetchImpl: fetchImpl as never });
    expect(log.text).toBe('café ok');
  });

  it('throws with the status when the gateway refuses', async () => {
    const fetchImpl = () =>
      Promise.resolve(fakeResponse([''], { status: 404 }));
    await expect(
      readJobLog(URL_, { fetchImpl: fetchImpl as never })
    ).rejects.toThrow(/404/);
  });

  it('bounds the default read at a ceiling a browser can hold', () => {
    expect(JOB_LOG_CEILING_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(JOB_LOG_CEILING_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe('[P1] formatByteSize', () => {
  it('names a size the way a viewer reads it', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(2048)).toBe('2 KiB');
    expect(formatByteSize(1536)).toBe('1.5 KiB');
    expect(formatByteSize(2 * 1024 * 1024)).toBe('2 MiB');
    expect(formatByteSize(9.4 * 1024 * 1024)).toBe('9.4 MiB');
  });
});
