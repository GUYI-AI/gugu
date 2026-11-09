import { describe, expect, it, vi } from 'vitest';
import type { Pty, PtyExitInfo } from './pty';
import { PtySessionRegistry } from './pty-session-registry';

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));

const writes = (pty: Pty) => vi.mocked(pty.write).mock.calls.map(([data]) => data);
const size = { cols: 80, rows: 24 };
const LIGHT = { foreground: '#171717', background: '#f4f4f4' };
/** Codex's Windows color probe: both queries at once, then a bounded read of the console input. */
const PROBE = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\';
const ANSWER = ['\x1b]10;rgb:1717/1717/1717\x1b\\', '\x1b]11;rgb:f4f4/f4f4/f4f4\x1b\\'];

function fakePty() {
  let onData: (d: string) => void = () => {};
  const pty: Pty & { out(d: string): void } = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (h) => (onData = h),
    onExit: (_h: (i: PtyExitInfo) => void) => {},
    out: (d) => onData(d),
  };
  return pty;
}

/** Output after the first batch reaches the screen on the next frame flush (16 ms); the screen parses asynchronously. */
async function parsed(registry: PtySessionRegistry, id: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await registry.screenText(id, 1);
}

describe('PtySessionRegistry color reports (@@@color-report)', () => {
  it('answers OSC 10/11 from the screen with the reported colors, with no terminal view attached', async () => {
    const registry = new PtySessionRegistry();
    registry.setReportColors({ foreground: '#171717', background: '#f4f4f4ff' });
    const pty = fakePty();
    registry.register('probe', pty, { size });

    pty.out(PROBE);
    await parsed(registry, 'probe');

    expect(writes(pty)).toEqual(ANSWER);
    registry.unregister('probe');
  });

  it('stays silent until colors are reported, then follows the latest (theme switch)', async () => {
    const registry = new PtySessionRegistry();
    const pty = fakePty();
    registry.register('theme', pty, { size });

    pty.out(PROBE);
    await parsed(registry, 'theme');
    expect(pty.write).not.toHaveBeenCalled();

    registry.setReportColors(LIGHT);
    registry.setReportColors({ foreground: '#ffffff', background: '#000000' });
    pty.out('\x1b]11;?\x07');
    await parsed(registry, 'theme');

    expect(writes(pty)).toEqual(['\x1b]11;rgb:0000/0000/0000\x1b\\']);
    registry.unregister('theme');
  });

  it('keeps answering after the agent respawns under the same id (restart / model switch)', async () => {
    const registry = new PtySessionRegistry();
    registry.setReportColors(LIGHT);
    const first = fakePty();
    registry.register('respawn', first, { size });
    registry.unregister('respawn', { pty: first });

    const second = fakePty();
    registry.register('respawn', second, { size });
    second.out(PROBE);
    await parsed(registry, 'respawn');

    expect(writes(second)).toEqual(ANSWER);
    registry.unregister('respawn');
  });

  it('answers a query split across two output chunks once', async () => {
    const registry = new PtySessionRegistry();
    registry.setReportColors(LIGHT);
    const pty = fakePty();
    registry.register('split', pty, { size });

    pty.out('\x1b]1');
    await parsed(registry, 'split');
    pty.out('1;?\x07');
    await parsed(registry, 'split');

    expect(writes(pty)).toEqual([ANSWER[1]]);
    registry.unregister('split');
  });

  it('lets set operations through without a reply', async () => {
    const registry = new PtySessionRegistry();
    registry.setReportColors(LIGHT);
    const pty = fakePty();
    registry.register('set', pty, { size });

    pty.out('\x1b]10;#ffffff\x1b\\\x1b]11;rgb:00/00/00\x07after');
    expect(await registry.screenText('set', 1)).toEqual(['after']);

    expect(pty.write).not.toHaveBeenCalled();
    registry.unregister('set');
  });

  it('keeps parsing when writing the reply throws', async () => {
    const registry = new PtySessionRegistry();
    registry.setReportColors(LIGHT);
    const pty = fakePty();
    vi.mocked(pty.write).mockImplementation(() => {
      throw new Error('EPIPE');
    });
    registry.register('throws', pty, { size });

    pty.out(`${PROBE}still parsing`);

    expect(await registry.screenText('throws', 1)).toEqual(['still parsing']);
    registry.unregister('throws');
  });

  it('does not answer a query the screen parses only after it was closed', async () => {
    const registry = new PtySessionRegistry();
    registry.setReportColors(LIGHT);
    const pty = fakePty();
    registry.register('closing', pty, { size });

    pty.out(PROBE);
    registry.unregister('closing');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(pty.write).not.toHaveBeenCalled();
  });
});
