import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placeUnder, type CanonicalPath } from '@gugu/session-shared/canonical-path';
import { canonicalPath, inWorkingCopy } from './paths';

let base: string;
let account: string;
let alias: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'canonical-')));
  // A server's account folder and the link its move left behind (`accounts/<id>` → `account`).
  account = path.join(base, 'account');
  mkdirSync(path.join(account, 'task-home', 'notes'), { recursive: true });
  writeFileSync(path.join(account, 'task-home', 'notes', 'a.md'), 'a');
  mkdirSync(path.join(base, 'accounts'));
  alias = path.join(base, 'accounts', 'u1');
  symlinkSync('../account', alias);
  outside = path.join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret'), 's');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('canonicalPath', () => {
  it('spells a folder and a file the same however they were named: through an alias, with `..`, or real', () => {
    const root = canonicalPath(path.join(account, 'task-home'));
    expect(canonicalPath(path.join(alias, 'task-home'))).toBe(root);
    expect(canonicalPath(path.join(alias, 'task-home', 'notes', '..'))).toBe(root);
    expect(canonicalPath(path.join(alias, 'task-home', 'notes', 'a.md'))).toBe(path.join(account, 'task-home', 'notes', 'a.md'));
  });

  it('keeps what is not there yet as named, under the real folder above it', () => {
    expect(canonicalPath(path.join(alias, 'task-home', 'new', 'deeper', 'b.md'))).toBe(path.join(account, 'task-home', 'new', 'deeper', 'b.md'));
  });

  it('resolves a folder link whole, and keeps a file link as its own name', () => {
    const home = path.join(account, 'task-home');
    symlinkSync(outside, path.join(home, 'out-dir'));
    symlinkSync(path.join(outside, 'secret'), path.join(home, 'key'));
    expect(canonicalPath(path.join(home, 'out-dir'))).toBe(outside);
    expect(canonicalPath(path.join(home, 'out-dir', 'secret'))).toBe(path.join(outside, 'secret'));
    expect(canonicalPath(path.join(home, 'key'))).toBe(path.join(home, 'key'));
  });

  it('takes only absolute paths', () => {
    expect(() => canonicalPath('task-home/a.md')).toThrow(/absolute/);
  });
});

describe('inWorkingCopy', () => {
  const at = (...parts: string[]) => canonicalPath(path.join(...parts));

  it('a file named through the alias is in its working copy, at its path there', () => {
    expect(inWorkingCopy(at(alias, 'task-home'), at(alias, 'task-home', 'notes', 'a.md'))).toBe('notes/a.md');
    expect(inWorkingCopy(at(account, 'task-home'), at(alias, 'task-home', 'notes', 'a.md'))).toBe('notes/a.md');
  });

  it('`..` out of it is out', () => {
    expect(inWorkingCopy(at(account, 'task-home'), at(account, 'task-home', '..', 'outside', 'secret'))).toBeNull();
    expect(inWorkingCopy(at(account, 'task-home', 'notes'), at(account, 'task-home', 'notes', '..', 'notes-other.md'))).toBeNull();
  });

  it('a link in it to a file outside is not a way out; to a file inside, it is that file', () => {
    const home = path.join(account, 'task-home');
    symlinkSync(path.join(outside, 'secret'), path.join(home, 'key'));
    symlinkSync(path.join(home, 'notes', 'a.md'), path.join(home, 'same.md'));
    expect(inWorkingCopy(at(home), at(home, 'key'))).toBeNull();
    expect(inWorkingCopy(at(home), at(home, 'same.md'))).toBe('same.md');
  });

  it('a folder link in it to a folder outside is outside, with all below it', () => {
    const home = path.join(account, 'task-home');
    symlinkSync(outside, path.join(home, 'out-dir'));
    expect(inWorkingCopy(at(home), at(home, 'out-dir'))).toBeNull();
    expect(inWorkingCopy(at(home), at(home, 'out-dir', 'secret'))).toBeNull();
  });

  it('a sibling folder whose name starts the same is not inside', () => {
    mkdirSync(path.join(account, 'task-home-2'));
    expect(inWorkingCopy(at(account, 'task-home'), at(account, 'task-home-2'))).toBeNull();
  });
});

describe('placeUnder (a window placing another machine’s paths)', () => {
  const c = (p: string) => p as CanonicalPath;
  it('places POSIX and Windows paths by their own separator', () => {
    expect(placeUnder(c('/srv/a'), c('/srv/a/x/y.md'))).toBe('x/y.md');
    expect(placeUnder(c('/srv/a'), c('/srv/ab/y.md'))).toBeNull();
    expect(placeUnder(c('/srv/a'), c('/srv/a'))).toBe('');
    expect(placeUnder(c('C:\\work\\a'), c('C:\\work\\a\\x\\y.md'))).toBe('x/y.md');
    expect(placeUnder(c('C:\\work\\a'), c('C:\\work\\ab\\y.md'))).toBeNull();
    expect(placeUnder(c('/'), c('/etc/x'))).toBe('etc/x');
  });
});
