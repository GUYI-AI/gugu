import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexSpawnDiagnostic, codexVersionFromUserAgent } from '@gugu/core/local/codex-spawn-diagnostic.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Codex spawn diagnostics', () => {
  it('resolves a selected shim without consulting PATH or logging credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-spawn-diagnostic-'));
    roots.push(root);
    await mkdir(join(root, 'native'));
    const binary = join(root, 'native', 'codex');
    const shim = join(root, 'codex');
    await writeFile(binary, 'fixture');
    await symlink(binary, shim);
    const diagnostic = codexSpawnDiagnostic({ executable: shim, nativeVersion: '0.167.2', appVersion: '0.3.8-beta.44511960747.1',
      mode: 'acp-stdio', phase: 'initialized', versionSource: 'initialize' });
    expect(diagnostic.executable).toBe(await realpath(binary));
    expect(diagnostic).toMatchObject({ nativeVersion: '0.167.2', versionSource: 'initialize', appVersion: '0.3.8-beta.44511960747.1' });
    expect(Object.keys(diagnostic)).toEqual(['providerId', 'mode', 'phase', 'executable', 'nativeVersion', 'versionSource', 'appVersion']);
  });

  it.each(['/Users/alice/.gugu/agents/codex', '/home/alice/bin/codex', 'C:\\Users\\alice\\bin\\codex'])('redacts the username in %s', executable => {
    const diagnostic = codexSpawnDiagnostic({ executable, mode: 'app-server-ws', phase: 'spawn' });
    expect(diagnostic.executable).not.toContain('alice');
    expect(diagnostic.executable).toContain('[user]');
    expect(diagnostic.nativeVersion).toBeNull();
    expect(diagnostic.versionSource).toBeNull();
  });

  it('only accepts bounded version facts from the native handshake', () => {
    expect(codexVersionFromUserAgent('codex_cli_rs/0.169.0 (Mac OS)')).toBe('0.169.0');
    expect(codexVersionFromUserAgent('codex_cli_rs/0.166.0-alpha.6')).toBe('0.166.0-alpha.6');
    expect(codexVersionFromUserAgent('not a version /Users/alice/auth')).toBeNull();
    expect(codexSpawnDiagnostic({ executable: 'codex', mode: 'acp-stdio', phase: 'spawn', nativeVersion: 'sk-private', appVersion: 'secret' })).toMatchObject({ nativeVersion: null, appVersion: null });
  });
});
