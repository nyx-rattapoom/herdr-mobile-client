import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { bytesToBase64, base64ToBytes, decodeUtf8, encodeUtf8, Utf8Stream, concatBytes } from '../core/bytes';
import { CORE_EXIT_NO_HC, coreConnectCommand, explainCoreClose, explainStrayStdout } from '../core/commands';
import {
  FRAME,
  FrameParser,
  CoreFrameError,
  MAX_FRAME_PAYLOAD,
  closeFrame,
  creditFrame,
  decodeCredit,
  decodeResize,
  encodeFrame,
  encodeJsonFrame,
  resizeFrame,
} from '../core/frames';

describe('byte helpers', () => {
  it('round-trips every byte value through base64', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const encoded = bytesToBase64(concatBytes(all, all, all));
    expect(base64ToBytes(encoded)).toEqual(concatBytes(all, all, all));
  });

  it('round-trips UTF-8 including surrogate pairs and invalid input', () => {
    const text = 'héllo 世界 🚀';
    expect(decodeUtf8(encodeUtf8(text))).toBe(text);
    expect(decodeUtf8(Uint8Array.of(0xff, 0xfe))).toBe('\ufffd\ufffd');
  });

  it('keeps a code point split across chunks intact', () => {
    const bytes = encodeUtf8('a🚀b');
    const stream = new Utf8Stream();
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += stream.push(bytes.subarray(i, i + 1));
    expect(out).toBe('a🚀b');
  });
});

describe('core commands', () => {
  // Runs the generated command with a real `sh`, as the SSH exec channel does.
  // Fake `hc` executables print which one ran and the argv they received.
  let root: string;
  let home: string;
  let pathBin: string;
  const fakeHc = (path: string, tag: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho "${tag} $*"\n`);
    chmodSync(path, 0o755);
  };
  const run = (hcPath?: string, opts: { pathHc?: boolean } = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${opts.pathHc ? `${pathBin}:` : ''}/usr/bin:/bin`, HOME: home, SHELL: '' };
    try {
      return { code: 0, out: execFileSync('/bin/sh', ['-c', coreConnectCommand(hcPath)], { env, stdio: 'pipe' }).toString().trim() };
    } catch (e) {
      const err = e as { status: number; stdout: Buffer };
      return { code: err.status, out: err.stdout.toString().trim() };
    }
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hc-cmd-')));
    home = join(root, 'home');
    pathBin = join(root, 'pathbin');
    mkdirSync(home, { recursive: true });
    fakeHc(join(pathBin, 'hc'), 'path');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exits 97 when hc is nowhere to be found', () => {
    expect(run()).toEqual({ code: CORE_EXIT_NO_HC, out: '' });
  });

  it('runs `hc connect` from PATH, then ~/.local/bin', () => {
    expect(run(undefined, { pathHc: true })).toEqual({ code: 0, out: 'path connect' });
    fakeHc(join(home, '.local/bin/hc'), 'local');
    expect(run()).toEqual({ code: 0, out: 'local connect' });
  });

  it('prefers an executable configured path, including ~/ paths, over PATH', () => {
    const configured = join(root, 'opt/hc');
    fakeHc(configured, 'configured');
    expect(run(configured, { pathHc: true })).toEqual({ code: 0, out: 'configured connect' });
    fakeHc(join(home, 'bin/hc'), 'home');
    expect(run('~/bin/hc', { pathHc: true })).toEqual({ code: 0, out: 'home connect' });
    expect(run(join(root, 'missing/hc'), { pathHc: true })).toEqual({ code: 0, out: 'path connect' });
  });

  it('refuses a stored hc path that fails validation instead of running it', () => {
    for (const bad of ['/x;id', '/a b', '$(id)', 'hc', '/x/../y']) {
      expect(() => coreConnectCommand(bad)).toThrow(expect.objectContaining({ code: 'hc_path_invalid' }));
    }
  });

  it('explains missing/non-executable hc without falling back to legacy', () => {
    expect(explainCoreClose({ reason: 'eof', exitCode: CORE_EXIT_NO_HC, stderr: '' }).code).toBe('hc_missing');
    expect(explainCoreClose({ reason: 'eof', exitCode: 126, stderr: '' }).code).toBe('hc_not_executable');
    expect(explainCoreClose({ reason: 'eof', exitCode: 1, stderr: 'boom' }).message).toContain('boom');
    expect(explainStrayStdout('Welcome to bash').code).toBe('hc_stdout');
  });
});

describe('frame wire format', () => {
  // Byte vectors from herdr-core schema/README.md (pinned in docs/SPIKE.md §7):
  // `[channel u32 LE][kind u8][len u32 LE][payload]`, CREDIT is u32 LE,
  // RESIZE is u16 LE cols then u16 LE rows.
  const DATA_258_HI = Uint8Array.of(0x02, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x68, 0x69);
  const CREDIT_3_1234 = Uint8Array.of(0x03, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x00, 0xd2, 0x04, 0x00, 0x00);
  const RESIZE_9_120x40 = Uint8Array.of(0x09, 0x00, 0x00, 0x00, 0x03, 0x04, 0x00, 0x00, 0x00, 0x78, 0x00, 0x28, 0x00);

  it('encodes DATA, CREDIT and RESIZE to the documented bytes', () => {
    expect(encodeFrame(258, FRAME.DATA, encodeUtf8('hi'))).toEqual(DATA_258_HI);
    expect(creditFrame(3, 1234)).toEqual(CREDIT_3_1234);
    expect(resizeFrame(9, 120, 40)).toEqual(RESIZE_9_120x40);
  });

  it('decodes the documented bytes', () => {
    const [data, credit, resize] = new FrameParser().push(concatBytes(DATA_258_HI, CREDIT_3_1234, RESIZE_9_120x40));
    expect([data.channel, data.kind, decodeUtf8(data.payload)]).toEqual([258, FRAME.DATA, 'hi']);
    expect([credit.channel, credit.kind, decodeCredit(credit.payload)]).toEqual([3, FRAME.CREDIT, 1234]);
    expect([resize.channel, resize.kind, decodeResize(resize.payload)]).toEqual([9, FRAME.RESIZE, { cols: 120, rows: 40 }]);
  });
});

describe('frame parser', () => {
  it('encodes and decodes headers, credit and resize payloads', () => {
    const f = encodeFrame(3, FRAME.CREDIT, (() => {
      const p = new Uint8Array(4);
      new DataView(p.buffer).setUint32(0, 1234, true);
      return p;
    })());
    const parsed = new FrameParser().push(f);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].channel).toBe(3);
    expect(parsed[0].kind).toBe(FRAME.CREDIT);
    expect(decodeCredit(parsed[0].payload)).toBe(1234);
    const r = new FrameParser().push(resizeFrame(9, 120, 40));
    expect(decodeResize(r[0].payload)).toEqual({ cols: 120, rows: 40 });
    expect(() => decodeCredit(Uint8Array.of(1))).not.toThrow();
    expect(decodeCredit(Uint8Array.of(1))).toBeNull();
  });

  it('parses the same frames split at every offset', () => {
    const one = encodeFrame(0, FRAME.DATA, encodeUtf8('{"id":1}'));
    const two = encodeFrame(7, FRAME.DATA, encodeUtf8('hello'));
    const three = closeFrame(7, 'exited');
    const stream = concatBytes(one, two, three);
    for (let split = 0; split <= stream.length; split++) {
      const parser = new FrameParser();
      const frames = [...parser.push(stream.subarray(0, split)), ...parser.push(stream.subarray(split))];
      expect(frames.map((f) => [f.channel, f.kind])).toEqual([
        [0, FRAME.DATA],
        [7, FRAME.DATA],
        [7, FRAME.CLOSE],
      ]);
      expect(decodeUtf8(frames[1].payload)).toBe('hello');
      expect(parser.remainder).toBe(0);
    }
  });

  it('accepts zero and exactly-16-MiB payloads and rejects one byte more before allocating', () => {
    expect(new FrameParser().push(encodeFrame(1, FRAME.DATA))[0].payload.length).toBe(0);
    const big = encodeFrame(2, FRAME.DATA, new Uint8Array(MAX_FRAME_PAYLOAD));
    const frames = new FrameParser().push(big);
    expect(frames[0].payload.length).toBe(MAX_FRAME_PAYLOAD);
    const header = new Uint8Array(9);
    header[4] = FRAME.DATA;
    new DataView(header.buffer).setUint32(5, MAX_FRAME_PAYLOAD + 1, true);
    expect(() => new FrameParser().push(header)).toThrow(CoreFrameError);
    expect(() => encodeFrame(1, FRAME.DATA, new Uint8Array(MAX_FRAME_PAYLOAD + 1))).toThrow(CoreFrameError);
  });

  it('waits for truncated headers and payloads, and rejects unknown kinds', () => {
    const frame = encodeFrame(4, FRAME.DATA, encodeUtf8('abc'));
    const p = new FrameParser();
    expect(p.push(frame.subarray(0, 8))).toEqual([]);
    expect(p.push(frame.subarray(8, 11))).toEqual([]);
    expect(decodeUtf8(p.push(frame.subarray(11))[0].payload)).toBe('abc');
    const bad = new Uint8Array(9);
    bad[4] = 99;
    expect(() => new FrameParser().push(bad)).toThrow(/unknown frame kind/);
  });

  it('encodes JSON on channel 0 as one framed message', () => {
    const f = encodeJsonFrame({ id: 1, method: 'x' });
    expect(f[0]).toBe(0);
    expect(f[4]).toBe(FRAME.DATA);
    const tail = new FrameParser().push(f)[0];
    expect(JSON.parse(decodeUtf8(tail.payload)).method).toBe('x');
    expect(creditFrame(1, 5).length).toBe(13);
  });
});
