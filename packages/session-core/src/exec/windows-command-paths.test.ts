import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findWindowsCommandPaths } from './windows-launcher';

/** A disk that holds exactly `files` and their parent directories (compared case-insensitively, as on NTFS). */
function disk(files: string[]) {
  const set = new Set(files.map((file) => file.toLowerCase()));
  const dirs = new Set(files.map((file) => file.slice(0, file.lastIndexOf('\\')).toLowerCase()));
  return {
    isFile: (candidate: string) => set.has(candidate.toLowerCase()),
    isDirectory: (candidate: string) => dirs.has(candidate.replace(/\\+$/, '').toLowerCase()),
  };
}

describe('findWindowsCommandPaths: PATH × PATHEXT in-process, no `where`', () => {
  const home = 'C:\\Users\\张 三\\gugu home\\agents\\mise-bin';

  it('finds a launcher under a path with spaces and Chinese characters, byte for byte', async () => {
    const env = { Path: `C:\\Windows\\System32;${home}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(await findWindowsCommandPaths('codex', { env, cwd: 'C:\\work', ...disk([`${home}\\codex.cmd`]) }))
      .toEqual([`${home}\\codex.cmd`]);
  });

  it('keeps `where` order: cwd first, then PATH, PATHEXT order within a directory; skips extensionless shims', async () => {
    const env = { PATH: 'C:\\a;"C:\\b c";;C:\\a', PATHEXT: '.EXE;.CMD' };
    const fs = disk(['C:\\work\\node.cmd', 'C:\\a\\node', 'C:\\a\\node.cmd', 'C:\\a\\node.exe', 'C:\\b c\\node.exe']);
    expect(await findWindowsCommandPaths('node', { env, cwd: 'C:\\work', ...fs })).toEqual([
      'C:\\work\\node.cmd',
      'C:\\a\\node.exe',
      'C:\\a\\node.cmd',
      'C:\\b c\\node.exe',
    ]);
  });

  it('looks only in the given directory for a path, and takes an exact extension first', async () => {
    const env = { PATH: 'C:\\elsewhere', PATHEXT: '.EXE;.CMD' };
    const fs = disk([`${home}\\codex.cmd`, 'C:\\elsewhere\\codex.cmd']);
    expect(await findWindowsCommandPaths(`${home}\\codex.cmd`, { env, ...fs })).toEqual([`${home}\\codex.cmd`]);
    expect(await findWindowsCommandPaths('C:/Users/张 三/missing/codex.cmd', { env, ...fs })).toEqual([]);
  });

  it('expands %VAR% from env (case-insensitive), and finds nothing when one does not expand', async () => {
    const env = { LocalAppData: 'C:\\Users\\张 三\\AppData\\Local', PATHEXT: '.EXE' };
    const zcode = 'C:\\Users\\张 三\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs';
    expect(await findWindowsCommandPaths('%LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs', { env, ...disk([zcode]) }))
      .toEqual([zcode]);
    expect(await findWindowsCommandPaths('%NOPE%\\zcode.cjs', { env, isFile: () => true, isDirectory: () => true })).toEqual([]);
  });

  it('resolves relative PATH entries and commands against the lookup cwd, like `where` run in that cwd', async () => {
    const env = { PATH: 'bin;C:\\abs', PATHEXT: '.EXE' };
    const fs = disk(['C:\\repo\\bin\\codex.exe', 'C:\\repo\\tools\\pi.exe']);
    expect(await findWindowsCommandPaths('codex', { env, cwd: 'C:\\repo', ...fs })).toEqual(['C:\\repo\\bin\\codex.exe']);
    expect(await findWindowsCommandPaths('.\\tools\\pi.exe', { env, cwd: 'C:\\repo', ...fs })).toEqual(['C:\\repo\\tools\\pi.exe']);
  });

  it('expands variables cmd accepts, like %ProgramFiles(x86)%, and uses the default PATHEXT when it is unset', async () => {
    const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', PATH: 'C:\\a' };
    const tool = 'C:\\Program Files (x86)\\Vendor\\tool.cmd';
    expect(await findWindowsCommandPaths('%ProgramFiles(x86)%\\Vendor\\tool.cmd', { env, ...disk([tool]) })).toEqual([tool]);
    expect(await findWindowsCommandPaths('tool', { env, cwd: 'C:\\w', ...disk(['C:\\a\\tool.bat']) })).toEqual(['C:\\a\\tool.bat']);
  });

  it('checks each directory once and skips one that is not there, instead of stat-ing every extension in it', async () => {
    const asked: string[] = [];
    const env = { PATH: 'Z:\\gone;C:\\a', PATHEXT: '.EXE;.CMD;.BAT' };
    const fs = disk(['C:\\a\\tool.cmd']);
    const isFile = (candidate: string) => { asked.push(candidate); return fs.isFile(candidate); };
    expect(await findWindowsCommandPaths('tool', { env, cwd: 'C:\\a', isFile, isDirectory: fs.isDirectory })).toEqual(['C:\\a\\tool.cmd']);
    expect(asked.some((candidate) => candidate.startsWith('Z:'))).toBe(false);
  });

  it('gives up with null after its time limit, so the caller can fall back to `where`', async () => {
    const env = { PATH: '\\\\dead-server\\share', PATHEXT: '.EXE' };
    const hang = () => new Promise<boolean>(() => {});
    expect(await findWindowsCommandPaths('tool', { env, cwd: 'C:\\w', isFile: hang, isDirectory: hang, timeoutMs: 20 })).toBeNull();
  });

  it.runIf(process.platform === 'win32')('finds a real file under a Chinese directory with a space', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-where-'));
    try {
      const dir = join(root, '测试 目录');
      mkdirSync(dir);
      writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\n');
      mkdirSync(join(dir, 'codex.exe'));
      expect(await findWindowsCommandPaths('codex', { env: { PATH: dir, PATHEXT: '.EXE;.CMD' }, cwd: root }))
        .toEqual([join(dir, 'codex.cmd')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
