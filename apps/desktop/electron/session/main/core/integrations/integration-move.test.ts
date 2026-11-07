import { describe, expect, it } from 'vitest';
import { integrationPluginRegistry } from '@gugu/session-plugins/integrations';
import { plainFormFields, summarizeAccountsForMove, type IntegrationMoveDeps } from './integration-move';

type Row = { accountId: string; displayName?: string; isDefault: boolean; credentials: Record<string, unknown> };

/** 一台机器的账号表:integrationId → 行;`unreadable` 是「有记录、凭据读不出来」。 */
function machine(
  rows: Record<string, Row[]>,
  opts: { cli?: string[]; unreadable?: Record<string, string[]>; plain?: Record<string, string[]> } = {}
): IntegrationMoveDeps {
  return {
    integrationIds: () => Object.keys(rows),
    isCli: (id) => (opts.cli ?? []).includes(id),
    plainFields: (id) => opts.plain?.[id] ?? [],
    listAccounts: async (id) => ({ accounts: rows[id] ?? [], unreadable: opts.unreadable?.[id] ?? [] }),
  };
}

/** 导出里任何一处(键或值)出现了这些串就算漏。 */
const SECRETS = ['tok-SECRET', 'key-SECRET', 'pw-SECRET', 'refresh-SECRET', 'client-SECRET'];

describe('助理搬家只交集成清单 (#7199 / #2104)', () => {
  it('每个账号只带名字、默认标记与不保密的配置;命令行那一家与读不出密钥的账号也列进要重新连', async () => {
    const out = await summarizeAccountsForMove(
      machine(
        {
          'enterprise-mail': [
            {
              accountId: 'a@x.cn',
              displayName: 'a@x.cn',
              isDefault: true,
              credentials: { imapHost: 'imap.x.cn', imapPort: '993', username: 'a@x.cn', password: 'pw-SECRET' },
            },
          ],
          notion: [{ accountId: 'default', isDefault: true, credentials: { accessToken: 'tok-SECRET', refreshToken: 'refresh-SECRET' } }],
          dingtalk: [{ accountId: 'default', isDefault: true, credentials: { tool: 'dws' } }],
          github: [],
        },
        {
          cli: ['dingtalk'],
          unreadable: { github: ['gh-cli-user'] },
          plain: { 'enterprise-mail': ['imapHost', 'imapPort', 'username', 'smtpHost'] },
        }
      )
    );

    expect(out.moving).toEqual([]);
    expect(out.reconnect).toEqual([
      {
        integrationId: 'enterprise-mail',
        accountId: 'a@x.cn',
        displayName: 'a@x.cn',
        isDefault: true,
        config: { imapHost: 'imap.x.cn', imapPort: '993', username: 'a@x.cn' },
        reason: 'account',
      },
      { integrationId: 'notion', accountId: 'default', isDefault: true, reason: 'account' },
      { integrationId: 'dingtalk', reason: 'cli' },
      { integrationId: 'github', accountId: 'gh-cli-user', reason: 'no-secret' },
    ]);
  });

  it('导出里不出现任何 token、key、secret、密码字段的值', async () => {
    const out = await summarizeAccountsForMove(
      machine(
        {
          amap: [{ accountId: 'default', isDefault: true, credentials: { apiKey: 'key-SECRET' } }],
          notion: [
            {
              accountId: 'default',
              isDefault: true,
              credentials: { accessToken: 'tok-SECRET', refreshToken: 'refresh-SECRET', clientSecret: 'client-SECRET' },
            },
          ],
          'enterprise-mail': [{ accountId: 'a@x.cn', isDefault: true, credentials: { imapHost: 'imap.x.cn', password: 'pw-SECRET' } }],
        },
        { plain: { 'enterprise-mail': ['imapHost'] } }
      )
    );
    const text = JSON.stringify(out);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"(?:[a-z]*token|[a-z]*key|[a-z]*secret|password|credentials)"/i);
  });

  it('注册表里每一家表单的不保密字段,都不是 token / key / secret / 密码', () => {
    for (const plugin of integrationPluginRegistry.getAll()) {
      for (const id of plainFormFields(plugin.capabilities.auth.methods)) {
        expect(`${plugin.metadata.id}.${id}`).not.toMatch(/token|key|secret|password|passwd|authcode/i);
      }
    }
  });

  it('一家一个账号都没连 → 不出现在清单里(没连 ≠ 要重新连)', async () => {
    const out = await summarizeAccountsForMove(machine({ notion: [], dingtalk: [] }, { cli: ['dingtalk'] }));
    expect(out.reconnect).toEqual([]);
  });
});
