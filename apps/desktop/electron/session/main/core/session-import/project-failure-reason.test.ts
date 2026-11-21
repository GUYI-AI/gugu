import { describe, expect, it } from 'vitest';
import { projectFailureCode } from './project-failure-reason';

// 原话都是本机实测出来的:node fs 的 errno 消息,以及 LC_ALL=C 下 git 的 stderr。
describe('projectFailureCode', () => {
  it.each([
    [{ type: 'path-not-found' }, 'project-not-found'],
    [{ type: 'invalid-directory', message: 'Invalid directory' }, 'project-not-found'],
    [{ type: 'inspect-failed', message: 'ENOENT: no such file or directory, opendir' }, 'project-not-found'],
    [{ type: 'error', message: "fatal: cannot change to '/work/webapp': No such file or directory" }, 'project-not-found'],
    [{ type: 'inspect-failed', message: "ENOTDIR: not a directory, stat '/work/webapp/x'" }, 'project-not-found'],
  ])('%j → %s', (failure, code) => {
    expect(projectFailureCode(failure)).toBe(code);
  });

  it.each([
    [{ type: 'path-access-blocked' }, 'project-permission-denied'],
    [{ type: 'inspect-failed', message: 'EACCES: permission denied, opendir' }, 'project-permission-denied'],
    [{ type: 'inspect-failed', message: "EACCES: permission denied, stat '/work/webapp/x'" }, 'project-permission-denied'],
    [{ type: 'error', message: "fatal: cannot change to '/work/webapp': Permission denied" }, 'project-permission-denied'],
    [{ type: 'inspect-failed', message: "EPERM: operation not permitted, stat '/work/webapp'" }, 'project-permission-denied'],
  ])('%j → %s', (failure, code) => {
    expect(projectFailureCode(failure)).toBe(code);
  });

  it.each([
    [{ type: 'not-repository' }, 'project-not-git'],
    [{ type: 'open-repository-failed', message: 'fatal: not a git repository (or any of the parent directories): .git' }, 'project-not-git'],
    [{ type: 'error', message: 'fatal: not a git repository (or any of the parent directories): .git' }, 'project-not-git'],
  ])('%j → %s', (failure, code) => {
    expect(projectFailureCode(failure)).toBe(code);
  });

  it('anything it does not recognise is the generic failure, never a guess', () => {
    expect(projectFailureCode({ type: 'error', message: 'git rev-parse --show-toplevel failed (exit 128)' })).toBe('project-open-failed');
    expect(projectFailureCode({ type: 'init-failed', message: 'UNIQUE constraint failed: projects.path' })).toBe('project-open-failed');
    expect(projectFailureCode({ type: 'error' })).toBe('project-open-failed');
  });

  it('permission wins when a message names both a permission problem and a missing path', () => {
    expect(projectFailureCode({ type: 'error', message: "EACCES: permission denied, stat '/work/no such file or directory/x'" })).toBe(
      'project-permission-denied'
    );
  });
});
