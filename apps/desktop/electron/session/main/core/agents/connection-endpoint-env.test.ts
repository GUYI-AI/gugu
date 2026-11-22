import { afterEach, expect, it, vi } from 'vitest';
import { buildAgentEnv } from '../pty/pty-env';
import { resolveSystemProxy } from '@main/utils/systemProxyEnv';
import { connectionProbeEnv, connectionProbeProxyEnv } from './connection-endpoint-env';

const state = vi.hoisted(() => ({ shell: {} as NodeJS.ProcessEnv }));
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => state.shell }));
const keys = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
afterEach(async () => { vi.unstubAllEnvs(); state.shell = {}; await resolveSystemProxy(async () => 'DIRECT'); });

it('matches agent shell/process/system-proxy resolution without mutating the worker environment', async () => {
  for (const key of keys) vi.stubEnv(key, undefined);
  await resolveSystemProxy(async () => 'PROXY 127.0.0.1:7897');
  const unchanged = { ...process.env };
  const transport = (env: NodeJS.ProcessEnv) => Object.fromEntries(keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
  expect(transport(connectionProbeEnv())).toEqual(transport(buildAgentEnv({})));
  expect(connectionProbeEnv()).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1,::1' });
  state.shell = { HTTPS_PROXY: 'http://shell:1', NO_PROXY: '.example.test' };
  expect(transport(connectionProbeEnv())).toEqual({ HTTPS_PROXY: 'http://shell:1', NO_PROXY: '.example.test' });
  expect(transport(connectionProbeEnv())).toEqual(transport(buildAgentEnv({})));
  vi.stubEnv('HTTPS_PROXY', 'http://process:2');
  expect(connectionProbeEnv().HTTPS_PROXY).toBe('http://process:2');
  expect(transport(connectionProbeEnv())).toEqual(transport(buildAgentEnv({})));
  delete unchanged.HTTPS_PROXY;
  const current = { ...process.env }; delete current.HTTPS_PROXY;
  expect(current).toEqual(unchanged);
});

it('transfers shell-only proxy values to the worker without exporting unrelated shell secrets', async () => {
  for (const key of keys) vi.stubEnv(key, undefined);
  await resolveSystemProxy(async () => 'PROXY 127.0.0.1:7897');
  state.shell = { https_proxy: 'http://shell:1', no_proxy: '.internal', PRIVATE_MODEL_KEY: 'do-not-export' };
  const workerOverrides = connectionProbeProxyEnv();
  expect(workerOverrides).toEqual({ https_proxy: 'http://shell:1', no_proxy: '.internal' });
  expect(workerOverrides).not.toHaveProperty('PRIVATE_MODEL_KEY');
  state.shell = {}; // The separate worker cannot read this provider.
  for (const [key, value] of Object.entries(workerOverrides)) vi.stubEnv(key, value);
  expect(connectionProbeProxyEnv()).toEqual(workerOverrides);
});
