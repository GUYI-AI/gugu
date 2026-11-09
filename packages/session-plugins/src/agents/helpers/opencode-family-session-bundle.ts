import { join } from 'node:path';
import { mcpToggleDirective, type McpToggleServer } from '@gugu/session-core/mcp';
import type {
  HarnessSessionSurface,
  SessionCapabilityBundle,
  SessionCredentialLifecycle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import {
  applyOpenCodeFamilyDisabledMcp,
  definedEnv,
  mergeOpenCodeFamilyOwnedConfig,
  openCodeFamilyMcpConfig,
  openCodeFamilyRunHome,
  parseOpenCodeFamilyConfig,
  type OpenCodeFamilyConfigSpec,
} from './opencode-family-session-config';

/** What differs between OpenCode and a fork that follows its serve/attach + ACP session contract. */
export interface OpenCodeFamilySessionBrand {
  readonly adapterId: string;
  readonly configSpec: OpenCodeFamilyConfigSpec;
  readonly surfaces: readonly HarnessSessionSurface[];
  readonly credentialLifecycle: (surface: HarnessSessionSurface) => SessionCredentialLifecycle;
  readonly modelConfig: (model: SessionCapabilityBundle['model']) => Record<string, unknown>;
  readonly permissionConfig: (
    autonomy: SessionCapabilityBundle['autonomy'],
    mcpServers: SessionCapabilityBundle['mcpServers'],
    surface: HarnessSessionSurface,
  ) => Record<string, unknown>;
  readonly sessionCreatePatch: (autonomy: SessionCapabilityBundle['autonomy']) => Readonly<{ agent?: string }> | undefined;
  readonly eventModulePath: string;
  readonly eventModuleContent: string;
  readonly eventModuleRetiredReason: string;
  /** When the session's model is on this provider, its small requests (titles) stay there too. */
  readonly smallModelFollowsProvider?: string;
}

function report(
  brand: OpenCodeFamilySessionBrand,
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle,
  config: Record<string, unknown>,
  promptValue: string
): SessionMaterialization['report'] {
  const loaded = () => ({ status: 'loaded' as const });
  const absent = (unit: string) => ({
    status: 'degraded' as const,
    reason: { code: 'unverified' as const, reason: `No ${unit} was declared.` },
  });
  return {
    adapterId: brand.adapterId,
    surface: ctx.surface,
    units: {
      mcp: loaded(),
      env: loaded(),
      model: bundle.model || typeof config.model === 'string' ? loaded() : absent('model'),
      autonomy: bundle.autonomy ? loaded() : absent('autonomy'),
      promptBlocks: promptValue ? loaded() : absent('prompt blocks'),
      // #4895: the workspace event module cannot be delivered safely: the upstream cold-installs a
      // dependency tree before ACP initialize, and neither leg consumes the module.
      packages: {
        status: 'degraded' as const,
        reason: { code: 'upstream-broken' as const, reason: brand.eventModuleRetiredReason },
      },
    },
    discoveredCommands: [],
  };
}

export function materializeOpenCodeFamilySession(
  brand: OpenCodeFamilySessionBrand,
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  const spec = brand.configSpec;
  if (!brand.surfaces.includes(ctx.surface)) {
    throw new Error(`${spec.displayName} session adapter does not support surface '${ctx.surface}'`);
  }
  const credentialLifecycle = brand.credentialLifecycle(ctx.surface);
  if (credentialLifecycle.delivery !== 'credential-proxy' || credentialLifecycle.recovery !== 'reopen') {
    throw new Error(`${spec.displayName} credential lifecycle for '${ctx.surface}' does not match ${spec.configEnvKey}`);
  }
  const runHome = openCodeFamilyRunHome(spec, bundle);
  const promptValue = (bundle.promptBlocks.platform ?? '') + (bundle.promptBlocks.identity ?? '');
  const instructionsPath = join(runHome, 'instructions', 'gugu-session.md');
  const baseConfig = parseOpenCodeFamilyConfig(spec, bundle.env[spec.configEnvKey]);
  const merge = (base: Record<string, unknown>, patch: Record<string, unknown>) =>
    mergeOpenCodeFamilyOwnedConfig(spec, base, patch);
  const config = merge(
    merge(
      merge(baseConfig, brand.modelConfig(bundle.model)),
      brand.permissionConfig(bundle.autonomy, bundle.mcpServers, ctx.surface),
    ),
    {
      // ⚠️ 这一句**必须留在这里求值**,❌ 不许提到上面去当局部变量:它在缺 Authorization 令牌时
      //    会抛,而提前求值会把它排到 model / permission 两次合并**之前** ——
      //    于是「用户自己写过 permission」那一格撞车时,用户看到的错从「permission 撞车」
      //    变成「MCP 令牌缺失」,病根指错了地方(单测抓到过,GATE-FAIL test:unit)。
      mcp: openCodeFamilyMcpConfig(spec, bundle),
      ...(promptValue ? { instructions: [instructionsPath] } : {}),
    }
  );
  // spec `mcp-session-toggle`:用户在 `/mcp` 里关掉的那几台,写成 `mcp.<名>.enabled = false`。
  //
  // ⚠️ **在合并之后**单独做 —— 上面那个 merge 对 `mcp` 下的同名是当场炸的,
  //    而那条守卫防的是「咕咕顶掉用户同名的 server」;这里**同名正是目的**。
  //
  // ⚠️ 归属(`owner`)在这里现算,**❌ 不比对名字常量**:咕咕自己那几台就是 `bundle.mcpServers`
  //    ——上面那个 patch 的 `mcp` 键正是逐个从它生成的,所以这是结构上的同一份事实,
  //    不会随「声明名 ≠ 配置键」漂掉。领域规则拿到 `owner: 'gugu'` 后会把它按回开着:
  //    关掉咕咕那台 = agent 变哑巴(活着、在干活、一个字传不回来),而用户只看到"没反应"。
  //    面板不列它是第一道;这里是第二道,因为面板不是这条路径唯一的入口。
  const guguOwned = new Set(bundle.mcpServers.map((server) => server.name));
  const toggleServers: McpToggleServer[] = (bundle.mcpDisabled ?? []).map((name) => ({
    name,
    enabled: false,
    owner: guguOwned.has(name) ? 'gugu' : 'user',
  }));
  const directive = mcpToggleDirective('config-content-enabled', toggleServers);
  const configWithToggles =
    directive.kind === 'config-content'
      ? applyOpenCodeFamilyDisabledMcp(config, directive.disabled)
      : config;
  const smallModel = brand.smallModelFollowsProvider
    && typeof config.model === 'string'
    && config.model.startsWith(`${brand.smallModelFollowsProvider}/`)
    ? { small_model: config.model }
    : {};
  const env = definedEnv(bundle.env);
  env[spec.configEnvKey] = JSON.stringify({ ...configWithToggles, ...smallModel });
  const createPatch = brand.sessionCreatePatch(bundle.autonomy);

  // @@@no-workspace-plugin-4895 — event module 不再投放到**任何** task surface。
  // 这一族把工作区里任何 `<brand>/plugins/*.js` 当 plugin origin,在应答 ACP `initialize` 前
  // 同步冷装 plugin 依赖树;冷装一旦超过 `DEFAULT_READY_TIMEOUT_MS`(10s)
  // 用户就看到 `Failed to load chat. / ACP initialize/ready timed out after 10000ms`(#4895)。
  // 而这个模块本就零消费者:acp 是 `<cli> acp` + connectStdioAcp 的 **stdio** 子进程,
  // 经 `buildAgentEnv({ agentApiVars: true })` 起,**从不拿到 `GUGU_HOOK_*`**;tui 走
  // serve/attach,回合边界从 serve 的 `/event` SSE 读,attach 那条 pty 同样没有 hook env。
  // ⇒ 两条腿都不投放。materializer 反而在两条腿上发 `retiredArtifacts`,按**逐字节**回收咕咕自己
  // 历史上写进工作区的那份插件。
  const artifacts = promptValue
    ? [{ path: instructionsPath, content: promptValue, mode: 0o600 as const }]
    : [];
  const retiredArtifacts = [
    {
      path: join(ctx.cwd, brand.eventModulePath),
      content: brand.eventModuleContent,
      target: 'workspace' as const,
    },
  ];

  return {
    argsAppend: [],
    env,
    ...(createPatch ? { sessionCreatePatch: createPatch } : {}),
    acp: { mcpServers: [] },
    configMerges: [],
    artifacts,
    retiredArtifacts,
    report: report(brand, ctx, bundle, config, promptValue),
  };
}
