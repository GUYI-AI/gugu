import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7240「编辑凭据」:存着的授权码只交还给原来那台服务器、原来那个地址(审查实撞:改了服务器又留空授权码,
 * 存着的授权码会被递给新服务器,还多出一条同一地址的账号)。
 */

const store = vi.hoisted(() => ({
  accounts: new Map<string, { accountId: string; credentials: Record<string, unknown> }>(),
  upsertError: null as Error | null,
}));

// #921 平台保管凭据那一侧不在本文件的范围:替成「没有平台保管的那几家」,❌ 牵进真的账号表与钥匙串。
vi.mock('./platform-credentials-instance', () => ({
  platformCredentials: { isPlatformProvider: () => false, custody: () => null },
}));
vi.mock('./integration-credential-store-instance', () => ({
  integrationCredentialStore: {
    getAccount: async (_id: string, accountId?: string) => (accountId ? store.accounts.get(accountId) ?? null : null),
    upsertAccount: async () => {
      if (store.upsertError) throw store.upsertError;
    },
    delete: async () => undefined,
  },
}));

const { IntegrationConnectionService } = await import('./integration-connection-service');
const { SecureStorageUnavailableError } = await import('@main/core/secrets/secure-storage-unavailable');
const { integrationPluginRegistry } = await import('@gugu/session-plugins/integrations');

const SAVED = 'imap.exmail.qq.com:a@corp.com';

beforeEach(() => {
  store.upsertError = null;
  vi.restoreAllMocks();
  store.accounts.clear();
  store.accounts.set(SAVED, {
    accountId: SAVED,
    credentials: {
      email: 'a@corp.com',
      password: 'saved-code',
      imapHost: 'imap.exmail.qq.com:993',
      smtpHost: 'smtp.exmail.qq.com:465',
    },
  });
});

describe('connect(editAccountId)', () => {
  it('改了服务器、授权码留空 → 拒绝,❌ 把存着的授权码递给新服务器', async () => {
    const result = await new IntegrationConnectionService().connect(
      'enterprise-mail',
      { email: 'a@corp.com', password: '', imapHost: 'imap.attacker.example:993', smtpHost: 'smtp.exmail.qq.com:465' },
      SAVED
    );
    expect(result).toEqual({
      success: false,
      error: 'imapHost changed: enter the authorization code again.',
      // 界面按它说「改了服务器或地址，要重新填一次密码或授权码」,❌ 说成「检查一下格式」(11-07 资源库盘点实测)。
      errorType: 'secret_required',
    });
  });

  it('那个账号已经不在了 → 说清楚,❌ 当成新账号去连', async () => {
    const result = await new IntegrationConnectionService().connect(
      'enterprise-mail',
      { email: 'a@corp.com', password: '', imapHost: 'imap.exmail.qq.com:993', smtpHost: 'smtp.exmail.qq.com:465' },
      'imap.exmail.qq.com:gone@corp.com'
    );
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('is not saved any more') });
  });
});

describe('connect: 这台电脑没有系统钥匙串', () => {
  it('存不进去 → secure_storage_unavailable,❌ 让 IPC 把英文原话抛给界面(11-07 Linux 无钥匙串实测)', async () => {
    const auth = integrationPluginRegistry.get('enterprise-mail')!.behavior.auth!;
    vi.spyOn(auth, 'verify').mockResolvedValue({ connected: true, displayName: 'b@corp.com' });
    store.upsertError = new SecureStorageUnavailableError('Secure secret storage is unavailable on this system.');
    const result = await new IntegrationConnectionService().connect('enterprise-mail', {
      email: 'b@corp.com',
      password: 'code',
      imapHost: 'imap.exmail.qq.com',
      smtpHost: 'smtp.exmail.qq.com',
    });
    expect(result).toEqual({
      success: false,
      error: 'Secure secret storage is unavailable on this system.',
      errorType: 'secure_storage_unavailable',
    });
  });

  it('别的存储错误照旧抛出,❌ 一律说成没有钥匙串', async () => {
    const auth = integrationPluginRegistry.get('enterprise-mail')!.behavior.auth!;
    vi.spyOn(auth, 'verify').mockResolvedValue({ connected: true });
    store.upsertError = new Error('disk full');
    await expect(
      new IntegrationConnectionService().connect('enterprise-mail', {
        email: 'b@corp.com',
        password: 'code',
        imapHost: 'imap.exmail.qq.com',
        smtpHost: 'smtp.exmail.qq.com',
      })
    ).rejects.toThrow('disk full');
  });
});
