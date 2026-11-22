import { describe, expect, it } from 'vitest';
import { expandWindowsEnvStrings, parseRegExportValue } from './windows-env';

describe('parseRegExportValue', () => {
  // What `reg export HKCU\SOFTWARE\GitForWindows` writes, decoded from its UTF-16LE file.
  const exported =
    '\uFEFFWindows Registry Editor Version 5.00\r\n\r\n' +
    '[HKEY_CURRENT_USER\\SOFTWARE\\GitForWindows]\r\n' +
    '"CurrentVersion"="2.47.1"\r\n' +
    '"InstallPath"="C:\\\\Users\\\\张三\\\\AppData\\\\Local\\\\Programs\\\\Git"\r\n' +
    '"LibexecPath"="C:\\\\Users\\\\张三\\\\AppData\\\\Local\\\\Programs\\\\Git\\\\mingw64\\\\libexec\\\\git-core"\r\n';

  it('reads a non-ASCII path back exactly, undoing the export escaping', () => {
    expect(parseRegExportValue(exported, 'InstallPath')).toEqual({
      value: 'C:\\Users\\张三\\AppData\\Local\\Programs\\Git',
      expand: false,
    });
  });

  it('matches the whole value name, not a prefix of another one', () => {
    expect(parseRegExportValue(exported, 'Install')).toBeNull();
    expect(parseRegExportValue(exported, 'MissingValue')).toBeNull();
  });
});

describe('expandWindowsEnvStrings', () => {
  it('expands names case-insensitively and leaves undefined ones as written', () => {
    expect(expandWindowsEnvStrings('%userprofile%\\bin;%NOPE%;50%', { USERPROFILE: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\bin;%NOPE%;50%');
  });
});
