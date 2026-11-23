import { describe, expect, it, vi } from 'vitest';
import type { Pty, PtyExitInfo } from './pty';
import { PtySessionRegistry } from './pty-session-registry';

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));
const size = { cols: 80, rows: 24 };
const LIGHT = { foreground: '#171717', background: '#f4f4f4' };
/** Codex's Windows color probe: both queries at once, then a bounded read of the console input. */
const PROBE = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\';

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

describe('PtySessionRegistry color reports (@@@color-report)', () => {

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
});
