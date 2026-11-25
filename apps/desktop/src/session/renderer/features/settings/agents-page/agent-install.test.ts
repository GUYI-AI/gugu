import { describe, expect, it } from 'vitest';
import type { AgentInstallError, AgentUpdateError } from '@shared/core/agents/agent-payload';
import { getAgentInstallErrorPresentation, getAgentUpdateErrorPresentation, npmBlockedBinPath } from './agent-install';

// Install and update fail the same way while their command runs; each also has its own outcomes.
const commandRunErrors = [
  { type: 'permission-denied', message: 'EACCES', output: '' },
  { type: 'permission-denied', message: 'EACCES', output: 'npm error code EACCES', stage: 'link', artifacts: [{ path: '/opt/x', bytes: null }] },
  { type: 'command-failed', message: 'exit 1', output: 'step one\nnpm error code E404\nmore' },
  { type: 'command-failed', message: 'exit 1', output: 'npm error code EEXIST\nnpm error path /usr/local/bin/claude' },
  { type: 'command-failed', message: 'exit 1', output: 'curl: (28) Connection timed out https://downloads.example.com/x.tgz' },
  { type: 'cancelled', message: 'cancelled', output: 'downloading' },
  { type: 'stalled', message: 'stalled', output: '', idleMs: 180_000 },
  { type: 'pty-open-failed', message: 'no pty' },
  { type: 'unsupported-host', message: 'unsupported' },
  { type: 'unknown-dependency', id: 'nope' },
] as const satisfies ReadonlyArray<AgentInstallError & AgentUpdateError>;

describe('install / update failure wording', () => {
  it.each(commandRunErrors)('words a $type failure the same for install and update', (error) => {
    const installations = [{ realpath: '/usr/local/bin/claude', pathEntry: null, version: '1.2.3', provenance: { kind: 'homebrew' } }];
    const install = getAgentInstallErrorPresentation(error, { installations });
    expect(getAgentUpdateErrorPresentation(error, { installations })).toEqual(install);
    expect(install.message).not.toBe('');
  });

  it('keeps the specific cause, the stage and the leftovers of a failed command', () => {
    expect(getAgentInstallErrorPresentation(commandRunErrors[1])).toEqual({
      message: 'Not enough permission to run that command.: npm error code EACCES',
      diagnostic: 'Failed at stage: link\n\nnpm error code EACCES\n\nPartial install remains at /opt/x (size unavailable).',
    });
    expect(getAgentInstallErrorPresentation(commandRunErrors[0])).toEqual({ message: 'Not enough permission to run that command.', diagnostic: null });
    expect(getAgentInstallErrorPresentation(commandRunErrors[2]).message).toBe('The command failed: npm error code E404');
  });

  it('names who holds the bin path npm refused to overwrite, or says it cannot tell', () => {
    const known = getAgentInstallErrorPresentation(commandRunErrors[3], {
      installations: [{ realpath: '/usr/local/bin/claude', pathEntry: null, version: '1.2.3', provenance: { kind: 'homebrew' } }],
    });
    expect(known.message).toContain('(Homebrew v1.2.3)');
    expect(getAgentInstallErrorPresentation(commandRunErrors[3]).message).toContain('holds a file npm does not own');
  });

  it('points at the one unreachable download host', () => {
    expect(getAgentInstallErrorPresentation(commandRunErrors[4]).message).toBe(
      'Cannot reach the download source downloads.example.com. Check that your network can access this address, then try again.',
    );
  });

  it('words the stalled and pre-command failures', () => {
    expect(getAgentUpdateErrorPresentation(commandRunErrors[6]).message).toContain('no progress for 3 min');
    expect(getAgentUpdateErrorPresentation(commandRunErrors[7])).toEqual({ message: 'Could not open a terminal to run the command: no pty', diagnostic: null });
    expect(getAgentUpdateErrorPresentation(commandRunErrors[9])).toEqual({ message: 'Unknown dependency: nope', diagnostic: null });
  });

  it('words the install-only outcomes', () => {
    expect(getAgentInstallErrorPresentation({ type: 'no-install-command', id: 'x' })).toEqual({
      message: 'No install command is available for x on this platform.',
      diagnostic: null,
    });
    expect(getAgentInstallErrorPresentation({ type: 'not-detected-after-install', id: 'x' })).toEqual({
      message: 'The command finished, but the agent still cannot be found.',
      diagnostic: null,
    });
  });

  it('words the update-only outcomes', () => {
    expect(getAgentUpdateErrorPresentation({ type: 'no-update-strategy', id: 'x' })).toEqual({ message: 'No update method is available for x.', diagnostic: null });
    expect(getAgentUpdateErrorPresentation({ type: 'not-detected-after-update', id: 'x' }).message).toBe(
      'The command finished, but the agent still cannot be found.',
    );
    expect(getAgentUpdateErrorPresentation({ type: 'version-unchanged', id: 'x', version: '2.0.0', path: '/bin/x' })).toEqual({
      message: 'The command finished, but v2.0.0 is still what runs (/bin/x) — the new version landed somewhere else.',
      diagnostic: '/bin/x (v2.0.0)',
    });
    expect(getAgentUpdateErrorPresentation({ type: 'version-unchanged', id: 'x', version: null, path: null })).toEqual({
      message: 'The command finished, but v? is still what runs (?) — the new version landed somewhere else.',
      diagnostic: null,
    });
  });

  it('reads the blocked bin path only from an EEXIST with an absolute path', () => {
    expect(npmBlockedBinPath('npm error code EEXIST\nnpm error path /usr/bin/x')).toBe('/usr/bin/x');
    expect(npmBlockedBinPath('npm error code EEXIST\nFile exists: C:\\bin\\x')).toBe('C:\\bin\\x');
    expect(npmBlockedBinPath('npm error code EEXIST\nnpm error path relative/x')).toBeNull();
    expect(npmBlockedBinPath('npm error path /usr/bin/x')).toBeNull();
  });
});
