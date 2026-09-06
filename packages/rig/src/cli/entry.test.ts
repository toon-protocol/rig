import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from './output.js';
import { runEntry } from './entry.js';

function fakeIo() {
  const out: string[] = [];
  const err: string[] = [];
  const json: unknown[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    emitJson: (value) => json.push(value),
    isInteractive: false,
    confirm: async () => false,
  };
  return { io, out, err, json };
}

describe('rig entry', () => {
  let home: string;
  let configPath: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rig-entry-'));
    configPath = join(home, 'config.json');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const env = (extra: Record<string, string> = {}) => ({
    TOON_CLIENT_HOME: home,
    ...extra,
  });
  const readConfig = () =>
    JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;

  it('bare `rig entry` with nothing configured reports so and how to fix it', async () => {
    const { io, out, json } = fakeIo();
    expect(await runEntry([], { io, env: env() })).toBe(0);
    expect(out.join('\n')).toMatch(/Connector\s+\(none\)\s+\[not configured\]/);
    expect(out.join('\n')).toMatch(/rig entry <connector-url>/);
    expect(json).toEqual([]);
  });

  it('records the connector (trailing slash trimmed) and the relay, preserving other fields', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ keystorePath: '/k.json', chain: 'solana' })
    );
    const { io, json } = fakeIo();
    expect(
      await runEntry(
        ['https://node.example/', '--relay', 'wss://relay.example', '--json'],
        { io, env: env() }
      )
    ).toBe(0);
    expect(readConfig()).toEqual({
      keystorePath: '/k.json',
      chain: 'solana',
      connectorUrl: 'https://node.example',
      relayUrl: 'wss://relay.example',
    });
    expect(json[0]).toMatchObject({
      command: 'entry',
      connectorUrl: 'https://node.example',
      connectorSource: 'config',
      relayUrl: 'wss://relay.example',
      relaySource: 'config',
      wrote: {
        connectorUrl: 'https://node.example',
        relayUrl: 'wss://relay.example',
      },
    });
  });

  it('env outranks config in the report, and a write says so', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ connectorUrl: 'https://file.example' })
    );
    const { io, json } = fakeIo();
    await runEntry(['--json'], {
      io,
      env: env({ TOON_CONNECTOR: 'https://env.example' }),
    });
    expect(json[0]).toMatchObject({
      connectorUrl: 'https://env.example',
      connectorSource: 'env',
    });
    const w = fakeIo();
    await runEntry(['https://new.example', '--json'], {
      io: w.io,
      env: env({ TOON_CONNECTOR: 'https://env.example' }),
    });
    expect((w.json[0] as { warnings: string[] }).warnings.join()).toMatch(
      /outranks the config file/
    );
  });

  it('a write retires the pre-4.0 proxyUrl/btpUrl fields', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        proxyUrl: 'https://old.example/ilp',
        btpUrl: 'wss://old.example/ilp/btp',
      })
    );
    const { io, json } = fakeIo();
    const before = fakeIo();
    await runEntry(['--json'], { io: before.io, env: env() });
    expect(before.json[0]).toMatchObject({
      connectorUrl: 'https://old.example/ilp',
      connectorSource: 'legacy-config',
    });
    await runEntry(['https://new.example', '--json'], { io, env: env() });
    expect(readConfig()).toEqual({ connectorUrl: 'https://new.example' });
    expect((json[0] as { warnings: string[] }).warnings.join()).toMatch(
      /pre-4\.0/
    );
  });

  it('`clear` forgets the connector and relay', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        connectorUrl: 'https://a',
        relayUrl: 'wss://r',
        chain: 'evm',
      })
    );
    const { io, json } = fakeIo();
    expect(await runEntry(['clear', '--json'], { io, env: env() })).toBe(0);
    expect(readConfig()).toEqual({ chain: 'evm' });
    expect(json[0]).toMatchObject({
      connectorUrl: null,
      connectorSource: null,
      wrote: { connectorUrl: null, relayUrl: null },
    });
  });

  it('usage errors never write', async () => {
    const cases: string[][] = [
      ['wss://node.example/ilp/btp'],
      ['bogus'],
      ['clear', '--relay', 'wss://r'],
      ['https://n', '--relay', 'https://not-ws'],
      ['https://a', 'https://b'],
    ];
    for (const args of cases) {
      const { io, err } = fakeIo();
      expect(await runEntry(args, { io, env: env() }), args.join(' ')).toBe(2);
      expect(err.join('\n')).toMatch(/Usage: rig entry/);
    }
    expect(existsSync(configPath)).toBe(false);
  });

  it('--help prints usage and exits 0', async () => {
    const { io, out } = fakeIo();
    expect(await runEntry(['--help'], { io, env: env() })).toBe(0);
    expect(out.join('\n')).toMatch(/Usage: rig entry/);
    expect(existsSync(configPath)).toBe(false);
  });
});
