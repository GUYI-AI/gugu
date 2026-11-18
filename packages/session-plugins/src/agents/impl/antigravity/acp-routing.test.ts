import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AcpSpawnContext } from '@gugu/session-core/agents/plugins';
import { pluginRegistry } from '../../registry';
import { buildAntigravityAcpSpawn } from './acp-routing';
import { canRepresentPermissionMode } from '@gugu/session-core/acp';
import { agentProgramFor } from '@gugu/session-core/deps/runtime';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const id = '11111111-2222-4333-8444-555555555555';

async function context(store?: 'antigravity-acp' | 'antigravity-cli') {
  const root = await mkdtemp(join(tmpdir(), 'agy-routing-'));
  roots.push(root);
  if (store) {
    await mkdir(join(root, store, 'conversations'), { recursive: true });
    await writeFile(join(root, store, 'conversations', `${id}.db`), 'fixture');
  }
  return {
    cwd: root, env: { GEMINI_HOME: root }, cli: '/managed/agy',
    programs: { antigravity: '/managed/agy_acp_server' },
    ...(store ? { providerSessionId: id } : {}),
  } as AcpSpawnContext & { providerSessionId?: string };
}

describe('one Antigravity provider routes each conversation to its original store', () => {
  it('does not register a second Antigravity provider', () => {
    expect(pluginRegistry.ids().filter(value => value.startsWith('antigravity'))).toEqual(['antigravity']);
  });
  it('resolves new ACP chats to the terminal CLI while preserving the primary legacy installation', () => {
    const provider = pluginRegistry.get('antigravity')!;
    expect(agentProgramFor(provider, 'primary').binaryName).toBe('agy_acp_server');
    expect(agentProgramFor(provider, 'acp')).toMatchObject({ dependencyId: 'antigravity-cli', binaryName: 'agy' });
  });
  it('starts new chat sessions on the same agy CLI as the terminal', async () => {
    const ctx = await context();
    expect(pluginRegistry.get('antigravity')!.behavior.acp!.buildSpawn(ctx)).toMatchObject({
      command: '/managed/agy', args: ['acp', '--stdio', '--gemini-dir', ctx.env.GEMINI_HOME],
    });
  });
  it('resumes standalone-server conversations through the resolved legacy program', async () => {
    expect(pluginRegistry.get('antigravity')!.behavior.acp!.buildSpawn(await context('antigravity-acp')))
      .toMatchObject({ command: '/managed/agy_acp_server', args: [] });
  });
  it('keeps CLI conversations on the CLI store', async () => {
    expect(pluginRegistry.get('antigravity')!.behavior.acp!.buildSpawn(await context('antigravity-cli')))
      .toMatchObject({ command: '/managed/agy', args: expect.arrayContaining(['acp']) });
  });
  it('refuses a missing stored conversation rather than silently opening it in another store', async () => {
    const ctx = await context(); ctx.providerSessionId = id;
    expect(() => pluginRegistry.get('antigravity')!.behavior.acp!.buildSpawn(ctx)).toThrow(/store|stored/i);
  });
  it('passes a Windows path with spaces as one argument to the native ACP process', () => {
    const root = 'C:\\Dev Home\\.gemini';
    const cli = 'C:\\Program Files\\agy.exe';
    expect(buildAntigravityAcpSpawn({ cwd: root, cli, env: { GEMINI_HOME: root } }))
      .toMatchObject({ command: cli, args: ['acp', '--stdio', '--gemini-dir', root] });
  });
  it('uses the chosen program even if the store file is no longer visible to the launcher', async () => {
    const ctx = await context();
    expect(buildAntigravityAcpSpawn({ ...ctx, providerSessionId: id, sessionProgram: 'antigravity' }))
      .toMatchObject({ command: '/managed/agy_acp_server', args: [] });
  });
  it('does not infer full access from the CLI auto mode', () => {
    const approval = pluginRegistry.get('antigravity')!.capabilities.autoApprove;
    expect(approval.modesExhaustive).toBe(true);
    expect(canRepresentPermissionMode('auto', 'full-access', approval.modes, approval.modesExhaustive)).toBe(false);
  });
  it('keeps explicit primary-program login on the standalone server', async () => {
    const ctx = { ...await context(), cli: '/managed/agy_acp_server', programs: undefined, authProgram: null };
    expect(buildAntigravityAcpSpawn(ctx)).toMatchObject({ command: '/managed/agy_acp_server', args: [] });
  });
});
