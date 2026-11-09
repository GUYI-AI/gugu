import { expect, it, vi } from 'vitest';

/**
 * 资源库按「agent 能不能直接用」分组(11-07 资源库盘点):Jira、GitLab 这类 issue 系统与 GitHub 连上以后
 * agent 什么都拿不到,只在咕咕界面里用 —— 它们进「仅界面」组,❌ 和能给 agent 工具的混排、也 ❌ 删掉。
 * 用真的注册表:新加一家时这里会提醒它该在哪一组。
 */
vi.mock('./platform-credentials-instance', () => ({
  platformCredentials: { isPlatformProvider: (id: string) => id === 'amap' || id === 'baidu-pan', custody: () => 'platform' },
}));
vi.mock('./integration-credential-store-instance', () => ({ integrationCredentialStore: { isConfigured: async () => false } }));
vi.mock('./integration-connection-service', () => ({ integrationConnectionService: { getFreshAccount: async () => null } }));

const { integrationReachesAgent } = await import('./session-integrations');
const { buildIntegrationListPayload } = await import('./integration-payload-builder');

it('splits the registry into what agents can call and what only the Gugu UI uses', () => {
  const entries = buildIntegrationListPayload('zh-CN', undefined, integrationReachesAgent);
  const uiOnly = entries.filter((entry) => entry.agentUse === false).map((entry) => entry.id).sort();
  expect(uiOnly).toEqual(
    ['asana', 'featurebase', 'forgejo', 'github', 'gitlab', 'jira', 'monday', 'plain', 'plane', 'trello'].sort()
  );
  expect(entries.filter((entry) => entry.agentUse === true)).toHaveLength(entries.length - uiOnly.length);
});

it('says nothing when the caller gives no verdict (older callers keep the old shape)', () => {
  expect(buildIntegrationListPayload('zh-CN').every((entry) => !('agentUse' in entry))).toBe(true);
});
