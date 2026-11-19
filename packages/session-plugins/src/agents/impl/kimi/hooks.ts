import type { PluginFs } from '@gugu/session-core/agents/plugins';
import type { HookRegistration } from '@gugu/session-core/agents/plugins';
import {
  GUGU_HOOK_MARKER,
  buildFlatTomlHookConfig,
  filterUserHooks,
  flatTomlHookEntries,
  makeStdinHookCommand,
  readTomlConfig,
  writeTomlConfig,
} from '@gugu/session-core/agents/plugins/helpers';

export const KIMI_CONFIG_PATH = '.kimi-code/config.toml';
export const KIMI_LEGACY_CONFIG_PATH = '.kimi/config.toml';

const KIMI_HOOK_ENTRIES = [
  { event: 'SessionStart', command: makeStdinHookCommand('session') },
  { event: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
  { event: 'PostToolUse', command: makeStdinHookCommand('start') },
  { event: 'PostToolUseFailure', command: makeStdinHookCommand('start') },
  { event: 'Notification', command: makeStdinHookCommand('notification') },
  { event: 'Stop', command: makeStdinHookCommand('stop') },
  { event: 'StopFailure', command: makeStdinHookCommand('stop') },
  { event: 'SessionEnd', command: makeStdinHookCommand('stop') },
];

/**
 * 旧版路径 `.kimi/config.toml`:**只更新、不创建**。无条件写会凭空造出一个「旧版 kimi-cli 安装」——
 * owner 2026-08-28 实测:咕咕的独立 home 里本来只有 `.kimi-code/`,写完之后多出一个只装着咕咕 hooks 的
 * `.kimi/config.toml`,kimi-code 一启动就弹「Found an existing kimi-cli installation … Migrate?」。
 * 读不懂就抛(同主路径,`readTomlConfig`),❌ 跳过后报成已写。返回写没写过。
 */
async function updateLegacyHooks(fs: PluginFs, install: boolean): Promise<boolean> {
  if (!(await fs.read(KIMI_LEGACY_CONFIG_PATH))) return false;
  const config = await readTomlConfig(fs, KIMI_LEGACY_CONFIG_PATH);
  if (!install && !Array.isArray(config.hooks)) return false;
  const user = filterUserHooks(flatTomlHookEntries(config));
  await writeTomlConfig(fs, KIMI_LEGACY_CONFIG_PATH, { ...config, hooks: install ? [...user, ...KIMI_HOOK_ENTRIES] : user });
  return true;
}

async function legacyHasGuguHooks(fs: PluginFs): Promise<boolean> {
  const config = await readTomlConfig(fs, KIMI_LEGACY_CONFIG_PATH);
  return flatTomlHookEntries(config).some((entry) => JSON.stringify(entry).includes(GUGU_HOOK_MARKER));
}

export function buildKimiHookConfig() {
  const main = buildFlatTomlHookConfig(KIMI_CONFIG_PATH, KIMI_HOOK_ENTRIES, {
    // 返回**真写过的**那些:这份清单会进 .gitignore / 残留清扫。
    afterWrite: async (fs) => ((await updateLegacyHooks(fs, true)) ? [KIMI_LEGACY_CONFIG_PATH] : []),
    afterDelete: async (fs) => { await updateLegacyHooks(fs, false); },
  });
  return {
    ...main,
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const installed = await main.readHooks(fs);
      if (installed.length) return installed;
      return (await legacyHasGuguHooks(fs)) ? [{ event: 'gugu', command: GUGU_HOOK_MARKER }] : [];
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      return (await main.getHooksInstalled(fs)) || (await legacyHasGuguHooks(fs));
    },
  };
}
