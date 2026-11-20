import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ root: '', run: vi.fn(), manager: { probe: vi.fn(), get: vi.fn(), getInstallOptions: vi.fn() } }));
vi.mock('./dependency-managers', () => ({ getDependencyManager: async () => mocks.manager }));
vi.mock('../agents/plugin-registry', () => ({ getPlugin: () => ({}) }));
vi.mock('@gugu/session-core/deps/runtime', async (original) => ({ ...(await original<typeof import('@gugu/session-core/deps/runtime')>()), agentProgramsOf: () => [{ dependencyId: 'codex' }] }));
vi.mock('./managed-agent-home', () => ({ managedAgentPrefix: () => mocks.root, managedMiseBinDir: () => path.join(mocks.root, 'active-bin') }));
vi.mock('./mise-installer', () => ({ runMiseOperation: mocks.run }));
vi.mock('../agents/ensure-agent-installed', () => ({ AgentInstallFailedError: class extends Error {} }));
vi.mock('@main/utils/userEnv', () => ({ ensureUserBinDirsInPath: vi.fn() }));
vi.mock('./managed-launcher-publication', () => ({ replaceManagedLauncher: vi.fn(), rollbackManagedLauncher: vi.fn(), withManagedLauncherPublication: vi.fn() }));

import { prepareAssistantRuntime } from '../../../../assistant-runtime-prepare';

beforeEach(async () => {
  mocks.root = await mkdtemp(path.join(os.tmpdir(), 'gugu-source-preparation-'));
  mocks.manager.probe.mockResolvedValue(undefined);
  mocks.manager.get.mockReturnValue({ status: 'missing' });
  const target = { kind: 'mise', package: '@openai/codex', binary: 'codex', backend: { kind: 'platform-archive', executables: {} } };
  mocks.manager.getInstallOptions.mockReturnValue(['official', 'npmmirror', 'huawei'].map(registry => ({ method: 'mise', target, registry, recommended: registry === 'official' })));
  mocks.run.mockReset().mockImplementation(async (_context, preparation) => {
    await mkdir(preparation.root, { recursive: true });
    await writeFile(path.join(preparation.root, 'own-candidate'), 'prepared');
    return { success: true, data: { registry: 'npmmirror' } };
  });
  await writeFile(path.join(mocks.root, 'active-sentinel'), 'active');
});
afterEach(async () => { await rm(mocks.root, { recursive: true, force: true }); });

it('background preparation enters the same automatic installer without turning its recommended option into an explicit preference', async () => {
  const signal = new AbortController().signal;
  const prepared = await prepareAssistantRuntime('operation-1', signal, 'codex');
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ mise: { target: expect.objectContaining({ binary: 'codex' }), operation: 'install',
    source: { kind: 'automatic', fallbackRegistry: 'official', registries: ['official', 'npmmirror', 'huawei'] } }, signal },
  { root: path.join(mocks.root, 'prepared/operation-1/runtime'), launcherDir: path.join(mocks.root, 'prepared/operation-1/entrypoints') });
  expect(await readFile(path.join(mocks.root, 'active-sentinel'), 'utf8')).toBe('active');
  await prepared.dispose();
  await expect(access(path.join(mocks.root, 'prepared/operation-1'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(mocks.root, 'active-sentinel'), 'utf8')).toBe('active');
});

it('failed preparation removes only its unpublished tree', async () => {
  const implementation = mocks.run.getMockImplementation()!;
  mocks.run.mockImplementation(async (...args) => { await implementation(...args); return { success: false, error: { type: 'command-failed' } }; });
  await expect(prepareAssistantRuntime('failed', new AbortController().signal, 'codex')).rejects.toThrow();
  await expect(access(path.join(mocks.root, 'prepared/failed'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(mocks.root, 'active-sentinel'), 'utf8')).toBe('active');
});
