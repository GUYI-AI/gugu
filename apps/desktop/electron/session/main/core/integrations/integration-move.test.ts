import { integrationPluginRegistry, type IntegrationCredentials } from '@gugu/session-plugins/integrations';
import { SecureStorageUnavailableError } from '@main/core/secrets/secure-storage-unavailable';
import { describe, expect, it } from 'vitest';
import {
  exportAccountsForMove,
  importAccountsFromMove,
  plainFormFields,
  type IntegrationMoveDeps,
  type MovableIntegrationAccount,
} from './integration-move';

type Row = { accountId: string; displayName?: string; isDefault: boolean; credentials: IntegrationCredentials };

/** 一台机器的账号表:integrationId → 行;`unreadable` 是「有记录、凭据读不出来」。 */
function machine(rows: Record<string, Row[]>, opts: { cli?: string[]; unreadable?: Record<string, string[]>; known?: string[]; plain?: Record<string, string[]> } = {}) {
  const store = new Map<string, Row[]>(Object.entries(rows).map(([id, list]) => [id, list.map((row) => ({ ...row }))]));
  const defaultCalls: [string, string][] = [];
  const warnings: unknown[] = [];
  const deps: IntegrationMoveDeps = {
    integrationIds: () => opts.known ?? [...store.keys()],
    isCli: (id) => (opts.cli ?? []).includes(id),
    hasIntegration: (id) => (opts.known ?? [...store.keys(), 'github', 'notion', 'qq-mail', 'dingtalk', 'enterprise-mail']).includes(id),
    plainFields: (id) => opts.plain?.[id] ?? [],
    warn: (message, context) => warnings.push({ message, context }),
    deleteAccount: async (id, accountId) => {
      store.set(id, (store.get(id) ?? []).filter((row) => row.accountId !== accountId));
    },
    listAccounts: async (id) => ({ accounts: store.get(id) ?? [], unreadable: opts.unreadable?.[id] ?? [] }),
    upsertAccount: async (id, account) => {
      const list = store.get(id) ?? [];
      const existing = list.find((row) => row.accountId === account.accountId);
      // 与真账号表同一条规矩:第一个写进去的当默认。
      if (existing) Object.assign(existing, { displayName: account.displayName, credentials: account.credentials });
      else list.push({ ...account, isDefault: list.length === 0 });
      store.set(id, list);
    },
    setDefault: async (id, accountId) => {
      const list = store.get(id) ?? [];
      if (!list.some((row) => row.accountId === accountId)) return false;
      for (const row of list) row.isDefault = row.accountId === accountId;
      defaultCalls.push([id, accountId]);
      return true;
    },
  };
  return { deps, store, defaultCalls, warnings };
}

describe('助理搬家带走账号类授权 (#7199)', () => {
  it('导出:账号连凭据与默认标记原样带上;命令行那一家与读不出密钥的账号逐条写进 skipped', async () => {
    const source = machine(
      {
        'qq-mail': [
          { accountId: 'a@qq.com', displayName: 'a@qq.com', isDefault: true, credentials: { authCode: 's1' } },
          { accountId: 'b@qq.com', isDefault: false, credentials: { authCode: 's2' } },
        ],
        notion: [{ accountId: 'default', isDefault: true, credentials: { accessToken: 'n' } }],
        dingtalk: [{ accountId: 'default', isDefault: true, credentials: { tool: 'dws' } }],
        github: [],
      },
      { cli: ['dingtalk'], unreadable: { github: ['gh-cli-user'] } }
    );

    const out = await exportAccountsForMove(source.deps);

    expect(out.accounts.map((a) => `${a.integrationId}/${a.accountId}/${a.isDefault}`)).toEqual([
      'qq-mail/a@qq.com/true',
      'qq-mail/b@qq.com/false',
      'notion/default/true',
    ]);
    expect(out.accounts[0]?.credentials).toEqual({ authCode: 's1' });
    expect(out.skipped).toEqual([
      { integrationId: 'dingtalk', reason: 'cli' },
      { integrationId: 'github', accountId: 'gh-cli-user', reason: 'no-secret' },
    ]);
  });

  it('导出:一家一个账号都没连 → 不出现在 skipped(没连 ≠ 没带走)', async () => {
    const source = machine({ notion: [], dingtalk: [] }, { cli: ['dingtalk'] });
    expect(await exportAccountsForMove(source.deps)).toEqual({ accounts: [], skipped: [] });
  });

  it('导入:写进对面账号表,默认账号照来源指定的、不看到达次序', async () => {
    const incoming: MovableIntegrationAccount[] = [
      { integrationId: 'qq-mail', accountId: 'a@qq.com', isDefault: false, credentials: { authCode: 's1' } },
      { integrationId: 'qq-mail', accountId: 'b@qq.com', displayName: 'B', isDefault: true, credentials: { authCode: 's2' } },
    ];
    const target = machine({});

    const result = await importAccountsFromMove(target.deps, incoming);

    expect(result).toEqual({ imported: 2, skipped: [] });
    const rows = target.store.get('qq-mail') ?? [];
    // 先到的 a 被账号表自动当了默认;搬家要把它改回来源里的 b。
    expect(rows.find((row) => row.isDefault)?.accountId).toBe('b@qq.com');
    expect(rows.find((row) => row.accountId === 'b@qq.com')?.credentials).toEqual({ authCode: 's2' });
    expect(target.defaultCalls).toEqual([['qq-mail', 'b@qq.com']]);
  });

  it('导入:新家不认的集成、命令行那几家不写,并如实说出来', async () => {
    const target = machine({}, { cli: ['dingtalk'], known: ['notion', 'dingtalk'] });
    const result = await importAccountsFromMove(target.deps, [
      { integrationId: 'notion', accountId: 'default', isDefault: true, credentials: { t: 1 } },
      { integrationId: 'from-the-future', accountId: 'x', isDefault: true, credentials: {} },
      { integrationId: 'dingtalk', accountId: 'default', isDefault: true, credentials: { tool: 'dws' } },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([
      { integrationId: 'from-the-future', accountId: 'x', reason: 'unknown-integration' },
      { integrationId: 'dingtalk', accountId: 'default', reason: 'cli' },
    ]);
    expect([...target.store.keys()]).toEqual(['notion']);
  });

  it('导入是幂等的:同一批再搬一次,只更新、不重复(搬到一半断了可以接着重来)', async () => {
    const incoming: MovableIntegrationAccount[] = [
      { integrationId: 'notion', accountId: 'default', isDefault: true, credentials: { t: 1, nested: { b: 2, a: 1 } } },
    ];
    const target = machine({});
    const first = await importAccountsFromMove(target.deps, incoming);
    // 键序不同的同一份凭据也算同一份
    const again = await importAccountsFromMove(target.deps, [{ ...incoming[0]!, credentials: { nested: { a: 1, b: 2 }, t: 1 } }]);

    expect(first.skipped).toEqual([]);
    expect(again).toEqual({ imported: 1, skipped: [] });
    expect(target.store.get('notion')).toHaveLength(1);
  });

  // 人在两头各自连过同一家(账号 id 同为 default):覆盖就把新家原来那个账号弄没了、旧家那份又被剪掉 —— 两个都丢。
  it('新家已经连着同 id 的另一份凭据:不覆盖,列进 skipped(reason exists),旧家那份由编排留着', async () => {
    const target = machine({
      notion: [{ accountId: 'default', displayName: '新家原来的', isDefault: true, credentials: { t: 'mine' } }],
    });
    const result = await importAccountsFromMove(target.deps, [
      { integrationId: 'notion', accountId: 'default', isDefault: true, credentials: { t: 'theirs' } },
      { integrationId: 'notion', accountId: 'work', isDefault: false, credentials: { t: 'w' } },
    ]);

    expect(result.skipped).toEqual([{ integrationId: 'notion', accountId: 'default', reason: 'exists' }]);
    expect(result.imported).toBe(1);
    expect(target.store.get('notion')?.find((a) => a.accountId === 'default')?.credentials).toEqual({ t: 'mine' });
    expect(target.store.get('notion')?.map((a) => a.accountId).sort()).toEqual(['default', 'work']);
  });
});

describe('存不进新家:逐条报回去手动重连,其余照常', () => {
  const secretAccount = (accountId: string, secret: string): MovableIntegrationAccount => ({
    integrationId: 'enterprise-mail', accountId, isDefault: false, credentials: { imapHost: 'imap.x.cn', password: secret }, config: { imapHost: 'imap.x.cn' },
  });

  it('写完读回的凭据与带来的不一致(密钥库截断 / 悄悄没落库)→ 这一条算没带过去,❌ 当成搬好', async () => {
    const target = machine({});
    const lossy = {
      ...target.deps,
      // 模拟密钥库只存了一半
      upsertAccount: async (integrationId: string, account: { accountId: string; displayName?: string; credentials: Record<string, unknown> }) =>
        target.deps.upsertAccount(integrationId, { ...account, credentials: { t: 'trunc' } as never }),
    };
    const result = await importAccountsFromMove(lossy, [{ integrationId: 'notion', accountId: 'default', isDefault: true, credentials: { t: 'full-token' } }]);
    expect(result).toEqual({ imported: 0, skipped: [{ integrationId: 'notion', accountId: 'default', reason: 'import-failed' }] });
    // 这条是这次才写的:不收回去就留下一个坏的「已连接」账号,以后再搬一直判 exists。
    expect(target.store.get('notion')).toEqual([]);
  });

  it('读回不对、但这条之前就有且读得出来:不删(那是新家原来的账号)', async () => {
    const target = machine({ notion: [{ accountId: 'default', isDefault: true, credentials: { t: 'same' } }] });
    const lossy = { ...target.deps, upsertAccount: async (integrationId: string, account: { accountId: string; credentials: IntegrationCredentials }) =>
      target.deps.upsertAccount(integrationId, { ...account, credentials: { t: 'trunc' } }) };
    const result = await importAccountsFromMove(lossy, [{ integrationId: 'notion', accountId: 'default', isDefault: true, credentials: { t: 'same' } }]);
    expect(result.skipped.map((s) => s.reason)).toEqual(['import-failed']);
    expect(target.store.get('notion')).toHaveLength(1);
  });

  it('读回不对、这条之前读不出密钥:也不删,那一行不是这次造的', async () => {
    const target = machine({ notion: [] }, { unreadable: { notion: ['default'] } });
    const deleted: string[] = [];
    const lossy = { ...target.deps, deleteAccount: async (_id: string, accountId: string) => { deleted.push(accountId); },
      upsertAccount: async () => {} };
    const result = await importAccountsFromMove(lossy, [{ integrationId: 'notion', accountId: 'default', isDefault: true, credentials: { t: 'x' } }]);
    expect(result.skipped.map((s) => s.reason)).toEqual(['import-failed']);
    expect(deleted).toEqual([]);
  });

  it('收回也失败:照样报回去,只记 id 和错误类型', async () => {
    const target = machine({});
    const lossy = { ...target.deps, deleteAccount: async () => { throw new Error('params SECRET'); },
      upsertAccount: async (integrationId: string, account: { accountId: string; credentials: IntegrationCredentials }) =>
        target.deps.upsertAccount(integrationId, { ...account, credentials: { t: 'trunc' } }) };
    const result = await importAccountsFromMove(lossy, [{ integrationId: 'notion', accountId: 'default', isDefault: true, credentials: { t: 'SECRET' } }]);
    expect(result.skipped.map((s) => s.reason)).toEqual(['import-failed']);
    expect(target.warnings).toHaveLength(2);
    expect(JSON.stringify(target.warnings)).not.toContain('SECRET');
  });

  it('新家没有钥匙串:每一条都标 no-keyring,带着不保密的配置,❌ 抛错让搬家失败', async () => {
    const target = machine({});
    const noKeyring = { ...target.deps, upsertAccount: async () => { throw new SecureStorageUnavailableError('Secure secret storage is unavailable on this system.'); } };
    const result = await importAccountsFromMove(noKeyring, [secretAccount('a@x.cn', 'pw-SECRET')]);
    expect(result).toEqual({ imported: 0, skipped: [{ integrationId: 'enterprise-mail', accountId: 'a@x.cn', config: { imapHost: 'imap.x.cn' }, reason: 'no-keyring' }] });
  });

  it('新家钥匙串锁着、连已有账号都读不出:同样不抛', async () => {
    const target = machine({});
    const locked = { ...target.deps, listAccounts: async () => { throw new SecureStorageUnavailableError('locked'); } };
    const result = await importAccountsFromMove(locked, [secretAccount('a@x.cn', 'pw-SECRET')]);
    expect(result.skipped.map((s) => s.reason)).toEqual(['no-keyring']);
  });

  it('导入中途一条失败:前后的照常存下,失败的逐条报回去;报回去的和日志里都没有凭据', async () => {
    const target = machine({});
    const flaky = {
      ...target.deps,
      upsertAccount: async (integrationId: string, account: { accountId: string; displayName?: string; credentials: IntegrationCredentials }) => {
        if (account.accountId === 'b@x.cn') throw new Error(`insert failed with params ${JSON.stringify(account.credentials)}`);
        await target.deps.upsertAccount(integrationId, account);
      },
    };
    const result = await importAccountsFromMove(flaky, [secretAccount('a@x.cn', 'pw-a-SECRET'), secretAccount('b@x.cn', 'pw-b-SECRET'), secretAccount('c@x.cn', 'pw-c-SECRET')]);
    expect(result.imported).toBe(2);
    expect(result.skipped.map((s) => [s.accountId, s.reason])).toEqual([['b@x.cn', 'import-failed']]);
    expect(target.store.get('enterprise-mail')?.map((a) => a.accountId)).toEqual(['a@x.cn', 'c@x.cn']);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(target.warnings)).not.toContain('SECRET');
    expect(target.warnings).toHaveLength(1);
  });

  it('默认账号没指成:账号已经存好,不算没搬', async () => {
    const target = machine({});
    const result = await importAccountsFromMove({ ...target.deps, setDefault: async () => { throw new Error('db busy'); } },
      [{ integrationId: 'notion', accountId: 'default', isDefault: true, credentials: { t: 1 } }]);
    expect(result).toEqual({ imported: 1, skipped: [] });
    expect(target.warnings).toHaveLength(1);
  });
});

describe('不保密的配置', () => {
  it('导出带上配置(手动重连时照着填):只有表单里不保密的字段,地址里夹带的账号密码去掉', async () => {
    const source = machine(
      { gitlab: [{ accountId: 'u', isDefault: true, credentials: { instanceUrl: 'https://bob:pw-SECRET@git.x.cn:8443/g?a=1', email: 'bob@x.cn', apiToken: 'tok-SECRET' } }] },
      { plain: { gitlab: ['instanceUrl', 'email'] } }
    );
    const out = await exportAccountsForMove(source.deps);
    expect(out.accounts[0]?.config).toEqual({ instanceUrl: 'https://git.x.cn:8443/g?a=1', email: 'bob@x.cn' });
  });

  it('注册表里每一家表单的不保密字段,都不是 token / key / secret / 密码', () => {
    for (const plugin of integrationPluginRegistry.getAll()) {
      for (const id of plainFormFields(plugin.capabilities.auth.methods)) {
        expect(`${plugin.metadata.id}.${id}`).not.toMatch(/token|key|secret|password|passwd|authcode/i);
      }
    }
  });
});

describe('确认框的预览', () => {
  it('只含名字,凭据字段一个都不出现(密钥不离开主进程)', async () => {
    const { previewAccountsForMove } = await import('./integration-move');
    const source = machine(
      {
        notion: [{ accountId: 'default', displayName: '阿满的 Notion', isDefault: true, credentials: { accessToken: 'SECRET-TOKEN' } }],
        dingtalk: [{ accountId: 'default', isDefault: true, credentials: { tool: 'dws' } }],
      },
      { cli: ['dingtalk'] }
    );
    const preview = await previewAccountsForMove(source.deps);
    expect(JSON.stringify(preview)).not.toContain('SECRET-TOKEN');
    expect(preview.moving).toEqual([{ integrationId: 'notion', accountId: 'default', displayName: '阿满的 Notion' }]);
    expect(preview.reconnect).toEqual([{ integrationId: 'dingtalk', reason: 'cli' }]);
  });
});
