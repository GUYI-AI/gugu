import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { claimBeforeRequest, releaseBeforeRequest } from './before-request';

const fakeSession = () => ({ webRequest: { onBeforeRequest: vi.fn() } }) as unknown as Session & { webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> } };

describe('a session has one onBeforeRequest listener, claimed once', () => {
  it('installs the first claim and throws on a second, leaving the first in place', () => {
    const ses = fakeSession();
    const first = vi.fn();
    claimBeforeRequest(ses, 'first', first);
    expect(() => claimBeforeRequest(ses, 'second', vi.fn())).toThrow('already belongs to first; second must join that listener');
    expect(ses.webRequest.onBeforeRequest).toHaveBeenCalledExactlyOnceWith(first);
    claimBeforeRequest(fakeSession(), 'another session', vi.fn());
  });

  it('a released claim takes its listener off, and the session can be claimed again', () => {
    const ses = fakeSession();
    claimBeforeRequest(ses, 'an App', vi.fn());
    releaseBeforeRequest(ses);
    expect(ses.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
    const again = vi.fn();
    claimBeforeRequest(ses, 'the App reinstalled', again);
    expect(ses.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(again);
  });

  // A direct call would silently replace a claimed listener; nothing outside the entry may make one.
  it('no source outside the entry installs an onBeforeRequest listener', () => {
    const root = join(__dirname, '../../../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.endsWith('before-request.ts')
          && /webRequest\.onBeforeRequest\(/.test(readFileSync(path, 'utf8'))) offenders.push(relative(root, path));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
