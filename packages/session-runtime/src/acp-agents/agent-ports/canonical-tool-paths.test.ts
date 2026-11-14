import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@gugu/session-core/acp';
import { canonicalToolPaths } from './canonical-tool-paths';

describe('canonicalToolPaths', () => {
  let base: string;
  let real: string;
  let alias: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'gugu-tool-paths-')));
    real = join(base, 'account', 'task-home');
    mkdirSync(real, { recursive: true });
    mkdirSync(join(base, 'accounts'));
    symlinkSync('../account', join(base, 'accounts', 'u1'));
    alias = join(base, 'accounts', 'u1', 'task-home');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('a tool call naming a file through a folder alias carries its one spelling, in its locations and its diff', () => {
    const event = {
      kind: 'tool_call',
      locations: [{ path: join(alias, 'a.md') }, { path: 'relative/b.md' }],
      contentBlocks: [{ type: 'diff', changes: [{ path: join(alias, 'a.md'), oldPath: join(alias, 'old.md') }] }],
    } as unknown as NormalizedEvent;
    const out = canonicalToolPaths({ kind: 'subagent_stream', event } as unknown as NormalizedEvent) as unknown as { event: { locations: { path: string }[]; contentBlocks: { changes: { path: string; oldPath: string }[] }[] } };
    expect(out.event.locations.map((l) => l.path)).toEqual([join(real, 'a.md'), 'relative/b.md']);
    expect(out.event.contentBlocks[0]!.changes[0]).toEqual({ path: join(real, 'a.md'), oldPath: join(real, 'old.md') });
  });

  it('other events pass as they are', () => {
    const event = { kind: 'message_chunk', text: join(alias, 'a.md') } as unknown as NormalizedEvent;
    expect(canonicalToolPaths(event)).toBe(event);
  });
});
