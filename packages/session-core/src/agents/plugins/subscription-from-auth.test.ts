/**
 * #2507 订阅页那一行读不出套餐时,由登录读数兜:没登录 → 「未登录」(这一行才有「登录」可点),
 * ❌ 把读套餐那一步撞出来的原始报错摆出来;没有套餐读法而登录了 → 按凭据说谁付钱。
 */
import { describe, expect, it, vi } from 'vitest';
import { createScope } from '@gugu/session-wire/util';
import { noopLogger } from '@gugu/session-shared/logger';
import { createPluginRegistry } from '@gugu/session-shared/plugins';
import { NodeExecutionContext } from '../../exec';
import type { AgentRunContext } from '../agent-run-context';
import type { AgentAuthStatus } from './capabilities/auth';
import type { SubscriptionPlanReading } from './capabilities/subscription';
import { createLocalPluginFs } from './helpers/local-plugin-fs';
import type { CLIAgentPluginProvider } from './index';
import { AgentPluginHost } from './plugin-host';

const scope = createScope({ label: 'subscription-from-auth', logger: noopLogger });

function provider(id: string, options: { status: AgentAuthStatus; plan?: SubscriptionPlanReading }): CLIAgentPluginProvider {
  let usageAsked = 0;
  const reader = options.plan
    ? {
        readPlan: async () => options.plan!,
        readUsage: async () => {
          usageAsked += 1;
          return { kind: 'unavailable' as const, reason: 'error' as const, message: `raw failure ${usageAsked}`, readAt: 0 };
        },
      }
    : undefined;
  return {
    metadata: { id, name: id },
    capabilities: {
      auth: { kind: 'supported', methods: [] },
      subscription: reader ? { kind: 'supported' } : { kind: 'none' },
    },
    behavior: { auth: { checkStatus: async () => options.status }, ...(reader ? { subscription: reader } : {}) },
  } as unknown as CLIAgentPluginProvider;
}

function host(...providers: CLIAgentPluginProvider[]) {
  const registry = createPluginRegistry<CLIAgentPluginProvider>();
  for (const p of providers) registry.register(p);
  // 宿主构造时按全部插件建安装描述;这里的假插件没有那一套,与 agent-home-retry.test 同一种做法。
  vi.spyOn(registry, 'getAll').mockReturnValue([]);
  return new AgentPluginHost({
    scope,
    registry,
    fs: createLocalPluginFs('/nonexistent-home'),
    homeDir: '/nonexistent-home',
    exec: new NodeExecutionContext({ env: { PATH: '/bin' } }),
  });
}

const run: AgentRunContext = {
  cli: { kind: 'resolved', path: '/opt/agent' },
  env: { PATH: '/bin' },
  configRootEnv: {},
  pinnedEnv: {},
  extraArgs: [],
};

describe('subscription reading falls back to the sign-in status', () => {
  it('a plan reader that failed while signed out reads "not signed in", and usage does not repeat the raw failure', async () => {
    const h = host(provider('copilot-like', { status: { kind: 'unauthenticated' }, plan: { payer: 'unknown', message: 'gh api failed' } }));
    expect(await h.readSubscription('copilot-like', run)).toEqual({ success: true, data: { payer: 'not-signed-in' } });
    const usage = await h.readSubscriptionUsage('copilot-like', run);
    expect(usage.success && usage.data).toMatchObject({ kind: 'unavailable', reason: 'not-signed-in' });
  });

  it('a plan that was read stays as read, even when the sign-in check disagrees', async () => {
    const h = host(provider('reads', { status: { kind: 'unauthenticated' }, plan: { payer: 'subscription', plan: 'Pro' } }));
    expect(await h.readSubscription('reads', run)).toEqual({ success: true, data: { payer: 'subscription', plan: 'Pro' } });
  });

  it('a failed plan reader while signed in keeps its own message (it is a real failure)', async () => {
    const h = host(provider('fails', { status: { kind: 'authenticated' }, plan: { payer: 'unknown', message: 'network down' } }));
    expect(await h.readSubscription('fails', run)).toEqual({ success: true, data: { payer: 'unknown', message: 'network down' } });
  });

  it('without a plan reader: signed out → not signed in; signed in with a known credential → who pays; otherwise unknown', async () => {
    const h = host(
      provider('out', { status: { kind: 'unauthenticated' } }),
      provider('key', { status: { kind: 'authenticated', credentialKind: 'api-key' } }),
      provider('sub', { status: { kind: 'authenticated', credentialKind: 'subscription' } }),
      provider('vague', { status: { kind: 'authenticated' } }),
      provider('unsure', { status: { kind: 'unknown' } })
    );
    expect(await h.readSubscription('out', run)).toEqual({ success: true, data: { payer: 'not-signed-in' } });
    expect(await h.readSubscription('key', run)).toEqual({ success: true, data: { payer: 'api-key' } });
    expect(await h.readSubscription('sub', run)).toEqual({ success: true, data: { payer: 'subscription' } });
    expect(await h.readSubscription('vague', run)).toEqual({ success: true, data: { payer: 'unknown' } });
    expect(await h.readSubscription('unsure', run)).toEqual({ success: true, data: { payer: 'unknown' } });
  });
});
