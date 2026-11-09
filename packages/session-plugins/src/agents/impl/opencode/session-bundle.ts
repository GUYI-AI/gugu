import { harnessPlatform } from './platform';
import {
  openCodeFamilyModelConfig,
  OPENCODE_REASONING_VARIANTS,
  type OpenCodeFamilyModelSpec,
} from '../../helpers/opencode-family-model-config';
import {
  openCodeFamilyPermissionConfig,
  type OpenCodeFamilyPermissionSpec,
} from '../../helpers/opencode-family-permission-config';
import type { OpenCodeFamilyConfigSpec } from '../../helpers/opencode-family-session-config';
import {
  materializeOpenCodeFamilySession,
  type OpenCodeFamilySessionBrand,
} from '../../helpers/opencode-family-session-bundle';
import { resolveSessionCredentialLifecycle } from '@gugu/session-core/agents/plugins';
import type {
  CapabilityPackage,
  HarnessSessionSurface,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionModelCapability,
} from '@gugu/session-core/agents/plugins';
import { OPENCODE_PLUGIN_CONTENT } from './plugin-file';

export const OPENCODE_GUGU_PACKAGE_ID = 'gugu-product-opencode';
export const OPENCODE_GUGU_PACKAGE_VERSION = '1.0.0';
export const OPENCODE_GUGU_EVENT_MODULE_PATH = '.opencode/plugins/gugu-notifications.js';
const OPENCODE_PLATFORM_PROVIDER_ID = 'gugu-platform';
const OPENCODE_PLATFORM_PROVIDER_NAME = 'Gugu 平台额度';
// OpenCode validates custom model entries against its current models.dev shape. The
// served GLM-5.2 catalog entry is context=1,000,000 and output=131,072; keep the
// output limit in the provider block instead of letting session/new reject the config.
const OPENCODE_PLATFORM_OUTPUT_LIMIT = 131_072;

export const OPENCODE_GUGU_CAPABILITY_PACKAGE: CapabilityPackage = {
  id: OPENCODE_GUGU_PACKAGE_ID,
  version: OPENCODE_GUGU_PACKAGE_VERSION,
  artifacts: [
    {
      path: OPENCODE_GUGU_EVENT_MODULE_PATH,
      content: OPENCODE_PLUGIN_CONTENT,
      mode: 0o644,
    },
  ],
};

export const opencodeSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: harnessPlatform,
  // ❌ `OPENCODE_CONFIG(_DIR)`:配置根归咕咕给(`configRootEnv`);`OPENCODE_SERVER_*` 只管 `opencode serve` / `web`,咕咕从不起这两个子命令。
  projectConfigDisableEnv: 'OPENCODE_DISABLE_PROJECT_CONFIG',
  shellEnv: {
    passThrough: ['OPENCODE_MODEL'],
    denied: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME'],
  },
  /**
   * 关自更新(#6186)。不关时 TUI 启动即查新版,patch 级直接调用安装方式自升级(改全局安装),
   * 其余级别弹「有新版」提示。env 与 config `autoupdate:false` 同一道门,这里走 env。
   */
  selfUpdate: {
    kind: 'session-env',
    env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    evidence:
      'anomalyco/opencode@2406400f0aeb packages/opencode/src/cli/upgrade.ts:10'
      + '「if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return」;'
      + ' 1.18.25 发行二进制同一段。取证 2026-09-23',
  },
  credentialLifecycle: {
    'acp': {
      delivery: 'credential-proxy',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'serve-process-descendants',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'replace',
    },
    'tui': {
      delivery: 'credential-proxy',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'serve-process-descendants',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'replace',
    },
  },
  /**
   * 终端腿(`tui`)于 #4406 补上。它曾被 PR #3785 有意保持「未实测故不申明」并由
   * registry 的 fail-loud 守卫拒绝 —— 撤守卫的依据是下面这轮**真机实测**
   * (opencode-ai@1.18.23,d15,tmux pty,产品同款 `OPENCODE_CONFIG_CONTENT` 形状 +
   * 逐字的 gugu-notifications.js 工件,取证 2026-08-28):
   *  · 配置通道:TUI 读 `OPENCODE_CONFIG_CONTENT` —— 假端点收到 `Bearer <配置里的 key>`、
   *    `model: <配置里的模型>`;**负对照**:不设该 env 再跑,假端点零请求(TUI 落回自家
   *    OpenCode Zen 默认)⇒ 因果成立,不是碰巧。
   *  · 首条消息:`--prompt <text>` 随启动自动提交(请求体里逐字出现探针串)。
   *  · promptBlocks:config `instructions` 指向的文件内容进了 system 载荷(魔法串命中)。
   *  · event module:工作区 `.opencode/plugins/gugu-notifications.js` 在 TUI 模式装载,
   *    带 `X-Gugu-Token`/`X-Gugu-Pty-Id` POST 出 `ses_*` 原生会话 id 与 idle 通知。
   *  · 续跑:`--session ses_…` 带回完整历史(与 prompt.buildCommand 里既有的
   *    `sessionIdOnResumeOnly + validateSessionId('ses') + --continue` 谱一致)。
   *  ⚠️ 1.18.23 校验自定义模型条目**必须带 `limit.context`**,缺了整个配置被拒、会话起不来
   *    (报「Missing key provider.….limit.context」)—— `opencode-family-model-config.ts` 只在
   *    contextWindow > 0 时写它,平台目录若缺窗口值,这条腿会 fail loud,不会静默。
   */
  surfaces: ['acp', 'tui'],
  sessionpage: {
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      // 注入时机升档(spec session-injection):忙时第二条**标准** `session/prompt` 3/3 同轮可见
      // (随机暗号在首条 `stopReason=end_turn` 前由 assistant chunk 复述,两个 RPC 响应在轮末
      // 数 ms 内到齐),idle 阳控 3/3。声明一落,内核的 steer 下水道即按 next-tool-call 直发,
      // 零内核 diff —— 此前它被挡成 idle-only 的唯一原因是机器的 PromptQueued 转换。
      // ⚠️ 读数属被测版本/模型路由;亚秒级临近轮末的竞态无读数,❌ 不外推。
      injection: {
        timing: 'next-tool-call',
        evidence: 'anomalyco/opencode@a3647eb025c7(v1.18.16)实测 2026-08-30:忙时第二条 session/prompt 3/3 同轮 + idle 阳控 3/3'
          + '(模型 opencode/mimo-v2.5-free)',
      },
    },
    // tui 经 serve/attach 走 router transport(专用 opencode-serve-attach-v1 adapter);delivery 不写 PTY。
    'tui': {
      identity: 'addressable',
      messageTransport: 'router',
      hostAdapter: 'opencode-serve-attach-v1',
    },
  },
  runtimeCompatibility: {
    'acp': { kind: 'semver-supported-floor', supportedFloor: '1.18.0', versionArgs: ['--version'] },
    // Fork endpoint provenance: upstream commit 6417edf99806b5aa93625622ba1726feae1a11fd
    // (https://github.com/anomalyco/opencode/commit/6417edf99806b5aa93625622ba1726feae1a11fd,
    // 2025-10-06, "Add todo list and session forking API endpoints") first added
    // POST /session/:id/fork and shipped in v0.14.4
    // (https://github.com/anomalyco/opencode/releases/tag/v0.14.4, 2025-10-07). The later v1.0.168
    // changelog entry is only the TUI slash-command. 1.18.23 is still the first
    // serve/attach runtime measured by Gugu; its floor is higher than the fork endpoint's
    // floor, so installs below 1.18.23 remain disabled for the complete sessionpage contract.
    'tui': { kind: 'semver-supported-floor', supportedFloor: '1.18.23', versionArgs: ['--version'] },
  },
  /**
   * spec `mcp-session-toggle` —— 这家怎么在会话级关掉一台 MCP server。
   *
   * `config-content-enabled`:在 `OPENCODE_CONFIG_CONTENT` 里逐台写 `enabled: false`。
   * 实测(2026-09-06,mac1,临时 HOME + 裸 ACP 客户端,判据是探针 server **自己的**
   * 调用账本且只看 `initialize` / `tools/list` —— 这两样是 harness 发的,与模型想不想用无关):
   *  · 磁盘配置里 `enabled: true` 原样不动,只在这份进程配置里写 `false` ⇒ 账本**全空**;
   *  · 去掉这一行再跑同一条会话 ⇒ 账本立刻出现 `initialize` + `tools/list`(阳控)。
   * ⇒ opencode 把 `OPENCODE_CONFIG_CONTENT` 与磁盘配置**合并**,而这里写的 `false` 赢。
   *   这正是零全局残留要的形状:用户自己的配置文件一个字节不动。
   */
  mcpToggle: { dialect: 'config-content-enabled' },
  units: {
    mcp: { kind: 'native', channel: 'process-config' },
    env: { kind: 'native', channel: 'child-process' },
    model: { kind: 'native', channel: 'process-config' },
    // 自治级别 —— 和 mcp/model/promptBlocks 同一条通道（`OPENCODE_CONFIG_CONTENT` 里的
    // `permission` 块），会话级、零持久化。形状与那个 fail-open 坑见
    // `helpers/opencode-family-permission-config.ts`。
    autonomy: { kind: 'native', channel: 'process-config' },
    promptBlocks: { kind: 'native', channel: 'process-config' },
  },
  extension: {
    kind: 'event-module',
    format: 'opencode',
    scope: 'workspace',
    carries: { mcp: 'none', skills: 'none', systemPrompt: 'none', hooks: 'module' },
  },
  /**
   * TUI 腿的中断键 —— **Esc 连按两下**。第一下只把状态条改成「esc again to interrupt」,
   * 计数 5 秒后清零;第二下才 `session.abort`。与 copilot 同形(那边也是 Esc×2)。
   *
   * 出处(anomalyco/opencode@ef2880f379129aa048be9e9353e30aa168d42c17,即 v1.18.23 tag):
   *  · `packages/tui/src/config/keybind.ts:97` —— `session_interrupt: keybind("escape", …)`;
   *  · `packages/tui/src/component/prompt/index.tsx:408-419` —— 计数 +1、`setTimeout 5000` 清零、
   *    `>= 2` 才 `sdk.client.session.abort({ sessionID })`。
   * 真机对照(1.18.23,2026-08-28):单发 Esc 后本轮持续在飞(慢端点拖 25s,状态条一直挂着
   * 提示);双发(间隔 1s)后界面立即复位、event module 的 idle 通知同秒到达。
   * ⚠️ 已知边界:abort 取消的是**会话轮**,底层到模型端点的 HTTP 连接不一定同步撕断
   *    (实测 socket 活过了整个慢窗口)—— 「停下」以 TUI/事件面为准,别拿网络层读数判它。
   * `intervalMs: 120` 是工程取值(与 copilot 同):远小于 5s 窗口,又不至于被终端并成一次按键。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    presses: 2,
    intervalMs: 120,
    evidence:
      'anomalyco/opencode@ef2880f379129aa048be9e9353e30aa168d42c17 '
      + 'packages/tui/src/config/keybind.ts:97 session_interrupt=escape;'
      + 'packages/tui/src/component/prompt/index.tsx:408-419 连按计数、5s 清零、>=2 才 '
      + 'session.abort。真机 1.18.23(2026-08-28):单发不停、双发立即复位且 idle 事件同秒上报',
  },
  /**
   * 终端腿的 `question` 选择器能从咕咕的提问卡回答(#7035):Esc = 拒绝这道题(工具结果「dismissed」,本轮结束),
   * 再把回答当消息发过去。
   */
  sessionTuiQuestionAnswer: {
    cancel: '\u001b',
    settleMs: 20,
    maxWaitMs: 2000,
    evidence:
      'anomalyco/opencode@388406238bd5 packages/tui/src/routes/session/question.tsx:253 keybind escape「Reject question」→ :57 reject();'
      + ' Esc 后再发消息 agent 照答:实测 1.18.28,6/6;取证 2026-10-09',
  },
  coexistence: {
    // 一条由 ACP 腿(surfaces 含 'acp',provider.acp 的 buildSpawn `opencode acp`
    // + connectStdioAcp)提供。双腿家的 pause 记 ACP 腿更强的 protocol-cancel,TUI 腿的
    // 中断键单独记在上面的 `sessionTuiInterrupt`(判据见 core 的 tuiInterruptSurfaceRequirement):
    //  · cancel:SessionMachine 的 'cancelling' 相 → cell.ts 打 agent.cancel({sessionId}),
    //    进程留着、会话还在,是**暂停**不是停止。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    // ⚠️ `todo` 曾按「surfaces 含 acp ⇒ 收得到结构化 plan」声明过,已撤 —— 那是横切外推。
    // #3889 横向发现②原文:「opencode / goose / letta 的 ACP 桥**不发 plan**;grok / mistral /
    // hermes 发 —— 3:3,是实现差异不是协议限制」。咕咕这一侧接得住(decode.ts 能解 kind:'plan'),
    // 断的是 opencode 自己那端不发。
    // ❌ 措辞注意:厂商侧**有** todo(证据串「todo事件」),不许改写成 `none` 去替厂商下结论;
    //    整条落回基类 = 咕咕经这条腿收不到结构化 plan。
    // 下面两条逐条核过,❌ 不是照「surfaces 含 acp」推的。关键事实:opencode 的 ACP 腿连的是
    // **厂商自己的** ACP server —— index.ts:104-108 的 buildSpawn 就是 `<cli> acp` + connectStdioAcp,
    // 中间**没有咕咕自建的桥**,咕咕不改写它的任何一条报文。codex 那种「桥只 respond/notify、
    // 从不发带 id 的客户端请求」的截断,在这条腿上结构性地不存在。
    // 咕咕这一侧是通用装配、不分家:connectStdioAcp → session-manager.ts:214 的 buildAgentClient。
    //  · session/update 经 agent-ports/agent-client.ts:53 → session-manager.ts:612 →
    //    session/cell.ts:182 的 push,machine/machine.ts:410 的 projectSessionState 产出
    //    isGenerating(:414/:423)与 canCancel(:425)。真机佐证:本目录
    //    __snapshots__/acp-fixture.test.ts.snap 里 config.availableCommands 是满的,而该字段只由
    //    `available_commands_update` 这条 session/update 写入(session-core acp/reducer/reducer.ts:511),
    //    tooling/fixtures/acp/drive-parser.ts 只补 config_option_update —— 只能是 opencode 自己发的通知。
    // ⚠️ 只取 acp-update 一个 channel:plugin-file.ts 那条 session.idle/session.error POST 到
    //    GUGU_HOOK_PORT(由 宿主 agent-hook-service 的 deriveAgentStatus 消费)是
    //    event-stream 的第二条通道,但一维只能记一个,ACP 腿这条更全,取它。
    observability: { kind: 'native', channel: 'acp-update' },
    //  · session/request_permission 经 agent-client.ts:57 → session-manager.ts:641 → cell.ts:318
    //    落进 pendingPermissions → session-chat-ui/src/state/chat-state.ts:364 摆到界面 →
    //    cell.ts:299 由人点选回填,是带 options 的往返、❌ 不是单向通知。
    //    这条腿确实按权限拦:opencode 只上报 build/plan 两档,「完全访问」只有 --auto /
    //    OPENCODE_PERMISSION 那条 TUI 路给得了(index.ts:44-46 登记在案的缺口),所以 ACP 会话跑的是
    //    「按配置权限执行」。⚠️ 证据分级:与 claude 不同,本目录没有可用的真机 transcript
    //    (__snapshots__ 那份是 #2804 并入时留下的孤儿快照,那一跑 agent 一句都没答上来),
    //    所以判「通」的依据是**咕咕侧从客户端半边到界面回填没有任何截断点**,不是逐字录到过这次往返。
    // ❌ 不是澄清型的 mcp-elicitation / native-tool:咕咕没有那条路。
    askUser: { kind: 'native', channel: 'permission-ask' },
    // opencodeMcpAdapter()(impl/opencode/index.ts 的 provider.mcp)的 readServers 扫
    // ~/.config/opencode/opencode.json 的 `mcp` 键(外加只读的旧路径 ~/.opencode/config.json),
    // 报出的是**用户自己写的**那些 server —— 不启引擎、纯读配置。
    introspection: { kind: 'native', channel: 'config-scan' },
    // 记忆文件读得到:`impl/opencode/index.ts` 的 capabilities.memory 登记了两条 AGENTS.md 入口
    // (出处见那一段),宿主经 AgentPluginHost.readMemoryFiles(plugin-host.ts:270)按登记逐条读回。
    // 那条路读的是磁盘、不需要会话,与这条 ACP 腿无关。
    // ⚠️ channel 必须与 capabilities.memory 登记的通道同名。
    memory: { kind: 'native', channel: 'agents-md' },
    // ⚠️ 别把 units.mcp('process-config' = 把咕咕的 server 塞进 OPENCODE_CONFIG_CONTENT)
    //    当成 introspection:那是**推**进去,读的是咕咕自己注的。
    // 其余三维(todo / history / cron)落回基类:hooks 走 createFileDropPlugin,
    // 只写/删/探咕咕自己那一个 event module,从不枚举用户自己的 plugin;
    // 历史读回只接了 claude-code 与 codex(transcriptInventory.ts)。
  },
} satisfies SessionBundleDescriptor;

/** Static capability shared by OpenCode ACP/TUI and its family materializer. */
export function opencodeCredentialLifecycle(surface: HarnessSessionSurface) {
  const lifecycle = resolveSessionCredentialLifecycle(opencodeSessionBundleDescriptor, surface);
  if (!lifecycle) throw new Error(`OpenCode credential lifecycle is undeclared for surface '${surface}'`);
  return lifecycle;
}

/**
 * 这一家在 opencode 系共用件里的身份。报错串与目录名与重构前**逐字相同** ——
 * 那些串是用户会看见的、也是测试钉住的。
 */
export const OPENCODE_FAMILY_CONFIG_SPEC: OpenCodeFamilyConfigSpec = {
  displayName: 'OpenCode',
  configEnvKey: 'OPENCODE_CONFIG_CONTENT',
  runHomeSlug: 'opencode-capability-runs',
};

/**
 * ⚠️ 这段形状与 MiMo-Code 那一家**必须逐字相同**（它是本家的 fork，配置 schema 一致），
 * 所以实现搬去了 `helpers/opencode-family-model-config.ts` 由两家共用。
 * 各写一份的话，漂移的那家会**静默走默认模型**（opencode 系对读不懂的键不报错），
 * 再被网关按单模型白名单拒掉 —— 症状离病根隔两层。❌ 别把它抄回来。
 */
export const OPENCODE_FAMILY_MODEL_SPEC: OpenCodeFamilyModelSpec = {
  displayName: 'OpenCode',
  dialect: 'opencode-config-content',
  platformProviderId: OPENCODE_PLATFORM_PROVIDER_ID,
  platformProviderName: OPENCODE_PLATFORM_PROVIDER_NAME,
  outputLimit: OPENCODE_PLATFORM_OUTPUT_LIMIT,
  reasoningVariants: OPENCODE_REASONING_VARIANTS,
};

function modelConfig(model: SessionModelCapability | null): Record<string, unknown> {
  return openCodeFamilyModelConfig(OPENCODE_FAMILY_MODEL_SPEC, model);
}

/**
 * `toolKeys` 从 opencode `packages/core/src/v1/config/permission.ts` 逐字转录
 * （2026-08-25 核对 opencode-ai@1.18.23）。MiMo 的那份**不一样**，别互相抄。
 */
export const OPENCODE_FAMILY_PERMISSION_SPEC: OpenCodeFamilyPermissionSpec = {
  displayName: 'OpenCode',
  toolKeys: [
    'read', 'edit', 'glob', 'grep', 'list', 'bash', 'task',
    'external_directory', 'todowrite', 'question', 'webfetch', 'websearch',
    'lsp', 'doom_loop', 'skill',
  ],
  approvalGatedKeys: ['bash', 'webfetch', 'websearch', 'external_directory', 'doom_loop'],
};

function permissionConfig(autonomy: SessionCapabilityBundle['autonomy']): Record<string, unknown> {
  if (!autonomy) return {};

  // `permissionMode` is transported unchanged until this provider boundary. OpenCode has two
  // native control channels: `session/new.agent` selects `plan` or `build`, while the config
  // document's `permission` rules control per-tool approval. An omitted field stays on the
  // legacy coarse mode (`edit` for the old false boolean), so old callers retain their behavior.
  if (autonomy.permissionMode !== undefined) {
    // `OPENCODE_PERMISSION_MODES.plan` is a native session mode (`agent: 'plan'`), not a
    // permission-rule alias. The session-create patch below is the only place that selects it.
    if (autonomy.permissionMode === 'plan') return {};
    const config = openCodeFamilyPermissionConfig(OPENCODE_FAMILY_PERMISSION_SPEC, {
      mode: autonomy.permissionMode === 'full-access' ? 'full-access' : 'approval-required',
    });
    if (autonomy.permissionMode === 'read-only') {
      // This branch is currently unreachable from the product because `OPENCODE_PERMISSION_MODES`
      // declares only `plan` and `edit` (OpenCode has no advertised read-only tier). Keep the
      // complete mapping so it becomes reachable without silently falling back to edit if that
      // declaration later adds `read-only`; its product reachability then requires a declaration
      // change, not a second materializer rule.
      // OpenCode has no separate read-only mode in serve/attach. Deny `edit` explicitly and keep
      // `bash: ask`: the latter is required because the provider has no OS sandbox, so a shell
      // write must be blocked or ask instead of executing. The helper's approval-required rule
      // set is `bash/webfetch/websearch/external_directory/doom_loop: ask`; all other tools,
      // including `read/glob/grep/list/lsp`, remain on the provider's default allow rule. This
      // is also the edit tier's contract, except edit does not add `edit: deny`.
      // Cross-provider guarantee is intentionally different: Codex's `sandbox_mode=read-only`
      // makes a write impossible (the command exits with an error, without asking), while
      // OpenCode's tool-granular model cannot deny `bash` without also denying `ls/cat/grep`.
      // Here a write may proceed only after the user approves the bash request; keep this ask
      // shape instead of copying Codex's hard sandbox semantics into OpenCode.
      const permission = config.permission;
      if (typeof permission !== 'object' || permission === null) {
        throw new Error('OpenCode read-only permission materialization did not produce a rule map');
      }
      return { permission: { ...permission, edit: 'deny' } };
    }
    return config;
  }

  return openCodeFamilyPermissionConfig(OPENCODE_FAMILY_PERMISSION_SPEC, autonomy);
}

function sessionCreatePatch(
  autonomy: SessionCapabilityBundle['autonomy'],
): Readonly<{ agent?: string }> | undefined {
  return autonomy?.permissionMode === 'plan' ? { agent: 'plan' } : undefined;
}

const OPENCODE_SESSION_BRAND: OpenCodeFamilySessionBrand = {
  adapterId: 'opencode',
  configSpec: OPENCODE_FAMILY_CONFIG_SPEC,
  surfaces: opencodeSessionBundleDescriptor.surfaces,
  credentialLifecycle: opencodeCredentialLifecycle,
  modelConfig,
  permissionConfig,
  sessionCreatePatch,
  eventModulePath: OPENCODE_GUGU_EVENT_MODULE_PATH,
  eventModuleContent: OPENCODE_PLUGIN_CONTENT,
  eventModuleRetiredReason:
    'OpenCode treats any workspace .opencode/plugins/*.js as a plugin origin and cold-installs '
    + '@opencode-ai/plugin before answering ACP initialize; neither session surface consumes the module '
    + '(no GUGU_HOOK_*), so it is retired rather than materialized (#4895).',
};

export function materializeOpencodeSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  return materializeOpenCodeFamilySession(OPENCODE_SESSION_BRAND, ctx, bundle);
}
