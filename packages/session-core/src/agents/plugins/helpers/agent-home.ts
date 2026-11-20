import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentHomeSegments, type ResolvedAgentHome } from '../capabilities/config-root';
import type { AgentInjectionMode, AgentConfigRoot, NativeHome } from '../capabilities/session-bundle';
import type { PluginFs } from '../../runtime/fs';
import type { AgentHomeProvisioner } from '../plugin-host';
import { createLocalPluginFs } from './local-plugin-fs';
import { readJsonConfig, writeJsonConfig, writeTomlOverlay } from './hook-config';
import { initializeManagedAgentHome } from './agent-home-import';
export * from './agent-home-import';

/**
 * 把独立 home 的落盘侧接给 `AgentPluginHost`。**每个 node 侧 boot 都该用它** ——
 * 各自现搓一份的话,「影子 home 的 fs 锚在哪一层」这种细节会在两处慢慢分叉。
 *
 * 拿不到 `GUGU_HOME` 就返回 `undefined` = 整套不启用(见 `AgentHomeProvisioner` 的注释):
 * ❌ 不猜一个默认路径 —— 猜错了会把配置写到没有运行时会读取的地方。
 */
export function createAgentHomeProvisioner(
  guguHome: string | undefined,
  osHomeDir: string,
  sourceEnv: Record<string, string | undefined>
): AgentHomeProvisioner | undefined {
  const root = guguHome?.trim();
  if (!root) return undefined;
  return {
    provision: async (providerId, injectionMode, spec) => {
      const home = resolveAgentHome({
        providerId,
        injectionMode,
        configRoot: spec,
        guguHome: root,
        osHomeDir,
        sourceEnv,
      });
      if (!home) return null;
      await ensureAgentHome(home);
      return home;
    },
    createFs: (fsRoot) => createLocalPluginFs(fsRoot, { mcpWriteScope: 'owned' }),
  };
}

/**
 * 原生配置根的候选:环境变量那份在前、默认那份在后,去重。覆盖不是替换 —— 挪过家的机器上默认目录里
 * 还留着旧会话,扫记录的读者扫全部;只问「现在用哪一份」的读者取第一个。
 */
export function nativeHomeRoots(
  nativeHome: NativeHome,
  env: Record<string, string | undefined>,
  osHomeDir: string
): string[] {
  const roots: string[] = [];
  for (const root of [env[nativeHome.envVar]?.trim(), join(osHomeDir, nativeHome.userPath)]) {
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * 算出这一家的独立 home。**纯路径拼接** —— 不碰磁盘、不判存在。
 * 没声明 `configRoot` 的家返回 `null` = 沿用用户的配置根,咕咕不为它另持一份。
 *
 * ⚠️ 它住在 helpers(node 侧)而不是 `capabilities/config-root.ts`,是因为要用 `node:path`,
 *    而那个文件进渲染包 —— 理由钉在那边的注释里,❌ 别搬回去。
 */
export function resolveAgentHome(input: {
  providerId: string;
  /**
   * 这一家声明的注入方式。**只有 `'managed-config-root'` 才有独立 home** ——
   * 运行时注入的家在这里就返回 `null`，整份复制那条路它够不到（#4834）。
   * ⚠️ ❌ 别改成「有 configRoot 就算托管」:那正是被判过的隐式推导。
   */
  injectionMode: AgentInjectionMode;
  configRoot: AgentConfigRoot | undefined;
  guguHome: string;
  osHomeDir: string;
  /**
   * 用户自己的环境。⚠️ **要**读:`envVar` 在用户那边设了,就说明他**把自己那份挪过家了** ——
   * 复制的来源得跟着挪,否则咕咕会从一个空的 `~/.kimi-code` 复制,而用户真正的配置在别处。
   * 这跟各家自己的解析式同形(kimi:`env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code')`)。
   */
  sourceEnv?: Record<string, string | undefined>;
}): ResolvedAgentHome | null {
  const spec = input.configRoot;
  if (input.injectionMode !== 'managed-config-root') {
    if (spec) {
      // fail loud:两个声明互相矛盾时,❌ 不许猜哪个是真的。
      throw new Error(
        `'${input.providerId}' 声明 injectionMode='${input.injectionMode}' 却又声明了 configRoot —— ` +
          `托管配置根只属于 'managed-config-root' 那一侧。删掉其一(见 product spec)。`
      );
    }
    return null;
  }
  if (!spec) {
    throw new Error(
      `'${input.providerId}' 声明 injectionMode='managed-config-root' 却没有 configRoot —— ` +
        `托管这一侧必须说清托管的是哪一份配置根。`
    );
  }
  if (!input.guguHome.trim()) {
    // fail loud:静默退回用户那份 = 登录写一处、会话读另一处,而两边都不报错。
    throw new Error(
      `独立 home 需要 GUGU_HOME:'${input.providerId}' 声明了 configRoot,但调用方没给咕咕的数据根`
    );
  }
  const segments = agentHomeSegments(input.providerId, spec.userPath);
  // 影子 home = 布局里除掉 userPath 那几段之后剩下的部分。
  const shadowSegments = segments.slice(0, 2);
  const shadowHome = join(input.guguHome, ...shadowSegments);
  const moved = input.sourceEnv?.[spec.envVar]?.trim();
  return {
    providerId: input.providerId,
    envVar: spec.envVar,
    shadowHome,
    configRoot: join(input.guguHome, ...segments),
    userConfigRoot: moved || join(input.osHomeDir, spec.userPath),
    osHomeDir: input.osHomeDir,
    carryExclusions: spec.carryExclusions.map((entry) => entry.path),
    importGroups: spec.importGroups.map((group) => ({ ...group, paths: group.paths.map((entry) => {
      const path = typeof entry === 'string' ? { path: entry } : entry;
      return moved && path.path.startsWith('../') ? { ...path, path: path.path.slice(3) } : entry;
    }) })),
    credentialPaths: spec.credentialPaths.map((entry) => entry.path),
    historySession: spec.historySession,
    upgradeHistory: spec.carryExclusions.filter((entry) => entry.upgradeHistory).map((entry) => entry.path),
    legacyCleanup: spec.legacyCleanup,
    seedFiles: (spec.seedFiles ?? []).map((seed) => ({ path: seed.path, content: seed.content })),
    firstRunState: spec.firstRunState ?? [],
  };
}

/** A managed home works as a fresh installation until migration supplies its configuration. */
export type AgentHomeSeed = 'already-present';
export async function ensureAgentHome(home: ResolvedAgentHome): Promise<AgentHomeSeed> {
  await initializeManagedAgentHome(home);
  await writeSeedFiles(home);
  return 'already-present';
}

/** Apply descriptor-declared dynamic trust/onboarding state through the shared write port. */
export async function applyAgentFirstRunState(
  home: ResolvedAgentHome,
  fs: PluginFs,
  cwd: string
): Promise<void> {
  for (const state of home.firstRunState ?? []) {
    const path = typeof state.relPath === 'function'
      ? state.relPath({ cwd, homeRoot: home.configRoot })
      : state.relPath;
    const entries = state.entries({ cwd, homeRoot: home.configRoot });
    if (state.format === 'json') {
      const current = await readJsonConfig(fs, path, 'user');
      await writeJsonConfig(fs, path, mergeStateEntries(current, entries), 'user');
      continue;
    }
    if (state.format === 'toml') {
      await writeTomlOverlay(fs, path, entries);
      continue;
    }
    const raw = (await fs.read(path)) ?? '';
    const lines = raw.length > 0 && !raw.endsWith('\n') ? `${raw}\n` : raw;
    const additions = Object.entries(entries)
      .filter(([key]) => !raw.split(/\r?\n/).includes(key))
      .map(([key, value]) => (value === true ? key : `${key}: ${String(value)}`))
      .join('\n');
    if (additions) await fs.write(path, `${lines}${additions}\n`);
  }
}

function mergeStateEntries(
  current: Record<string, unknown>,
  entries: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...current };
  for (const [key, value] of Object.entries(entries)) {
    const existing = out[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      out[key] = [...new Set([...existing, ...value])];
    } else if (isRecord(existing) && isRecord(value)) {
      out[key] = mergeStateEntries(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Descriptor-owned onboarding files are filled only when missing. */
async function writeSeedFiles(home: ResolvedAgentHome): Promise<void> {
  for (const seed of home.seedFiles) {
    const target = join(home.configRoot, seed.path);
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Exclusive writes preserve existing managed preferences.
    await fs.writeFile(target, seed.content, { flag: 'wx', mode: 0o600 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return;
      throw error;
    });
  }
}
