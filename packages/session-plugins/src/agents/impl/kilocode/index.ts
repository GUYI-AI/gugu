import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  buildStandardCommand,
  createFileDropPlugin,
  miseDependency,
  BARE_VERSION_LINE,
} from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import {
  effortOptionsFromReasoningVariants,
  OPENCODE_REASONING_VARIANTS,
} from '../../helpers/opencode-family-model-config';
import { opencodeFamilyListedTitle } from '../../helpers/opencode-family-title';
import { kilocodeAuthStatus, kilocodeModelCredential } from './auth';
import { icon } from './icon';
import { kilocodeMcpAdapter } from './mcp';
import { KILOCODE_PERMISSION_MODES } from './permission-modes';
import { platformModel } from './platform-model';
import { KILOCODE_PLUGIN_CONTENT } from './plugin-file';
import {
  KILOCODE_GUGU_EVENT_MODULE_PATH,
  kilocodeSessionBundleDescriptor,
  materializeKilocodeSessionBundle,
} from './session-bundle';

const validateProviderSessionId = (id: string) => id.startsWith('ses');

const HOT_SETTING = {
  channel: 'acp-config-option',
  ack: 'ack-read-back',
  busy: 'reject',
  reloadRequired: false,
  recovery: 'none',
} as const;

export const plugin = definePlugin(
  {
    id: 'kilocode',
    name: 'Kilo',
    description:
      'Kilo AI coding assistant with multiple modes, broad model support, and checkpoint-based workflows.',
    websiteUrl: 'https://kilo.ai/docs/cli',
  },
  {
    sessionBundle: kilocodeSessionBundleDescriptor,
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '只给 KILO_CONFIG_CONTENT 里的自定义 provider、零厂商凭据,`kilo acp` 一回合 end_turn,假端点收到 /v1/responses(7.8.27,2026-11-08)',
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'kilo-login',
          name: 'Sign in with Kilo',
          args: ['auth', 'login'],
          description: 'Open the Kilo CLI sign-in flow in a terminal.',
        },
      ],
    },
    acp: {
      kind: 'supported',
      // Measured on one live session (7.8.27): model, effort and mode each read back after
      // set_config_option, and the next request carried the new model and reasoning effort.
      liveSettings: {
        model: HOT_SETTING,
        permission: HOT_SETTING,
        effort: HOT_SETTING,
      },
    },
    effort: {
      kind: 'selectable',
      effortOptions: effortOptionsFromReasoningVariants(OPENCODE_REASONING_VARIANTS),
      resetId: 'default',
    },
    autoApprove: {
      kind: 'supported',
      modes: KILOCODE_PERMISSION_MODES,
    },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'listed', prefix: 'gugu_', evidence: '7.8.27 发往假端点的 tools 数组里是 `gugu_<tool>`,该工具的调用到达了 MCP server(2026-11-08)' },
      sessionUserServers: 'inherit',
    },
    hooks: {
      kind: 'plugin',
      scope: 'workspace',
      supportedEvents: ['notification', 'stop', 'session'],
    },
    // 托管安装:程序体在 `@kilocode/cli-<platform>-<arch>` 里(六格齐全,归档内 `bin/kilo`)。
    // `id` 写厂商真正的二进制名 `kilo` —— 它同时是启动器文件名与探测名,写成 `kilocode`
    // 就再也认不出用户自己装的那一份。
    hostDependency: { ...miseDependency({
      id: 'kilo',
      package: '@kilocode/cli',
      platformPackages: {
        'darwin-x64': '@kilocode/cli-darwin-x64', 'darwin-arm64': '@kilocode/cli-darwin-arm64',
        'linux-x64': '@kilocode/cli-linux-x64', 'linux-arm64': '@kilocode/cli-linux-arm64',
        'win32-x64': '@kilocode/cli-windows-x64', 'win32-arm64': '@kilocode/cli-windows-arm64',
      },
      executables: {
        'darwin-x64': 'bin/kilo', 'darwin-arm64': 'bin/kilo',
        'linux-x64': 'bin/kilo', 'linux-arm64': 'bin/kilo',
        'win32-x64': 'bin/kilo.exe', 'win32-arm64': 'bin/kilo.exe',
      },
    }), versionLine: BARE_VERSION_LINE },
    plugins: {
      kind: 'file-drop',
      scope: 'workspace',
    },
    // agent memory —— kilocode 读 AGENTS.md 系。
    // 出处:https://kilo.ai/docs/customize/agents-md(取证 2026-08-24)——「Place your AGENTS.md
    // file at the root of your project」,文件名按 `AGENTS.md`(推荐)→ `AGENT.md`(回退)取,
    // 且原文强调必须大写。同页另说 CLI 兼容 `.claude/` 与 `.agents/` 目录。
    // ⚠️ 两处**故意没登记**,是取证不足不是漏做:
    //  · 子目录里的 AGENTS.md(官方说「in subdirectories to provide context-specific
    //    instructions」)—— `AgentMemoryEntry` 表达不了「整棵树递归找」,硬写一层是猜。
    //  · `.claude/` / `.agents/` 兼容目录 —— 官方没写具体文件名,登记错就会读回不是记忆的东西。
    //  · global 作用域官方一条都没写(只提到 global `kilo.jsonc` 放 instructions,那是配置不是
    //    记忆文件)→ ❌ 不许照别家的 `~/.<vendor>/` 惯例外推。
    // ⚠️ `satisfies` 不是装饰,理由同 sessionBundle(zod 4 的 ZodType Input 是 unknown)。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENT.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'argv',
      // `kilo <positional>` is interpreted as the project directory and gets
      // realpath()'d, which throws ENAMETOOLONG on large prompts (ENG-1546).
      // The interactive TUI accepts the initial prompt via `--prompt` instead.
      flag: '--prompt',
      // serve/attach: the visible pty only attaches, so the first turn goes through the delivery bridge.
      startupDelivery: 'delivery-bridge',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeKilocodeSessionBundle, platformModel },
  auth: {
    checkStatus: kilocodeAuthStatus,
    modelCredential: kilocodeModelCredential,
  },
  acp: {
    ...createNativeAcpBehavior(() => ({
      args: ['acp'],
    })),
    sessionTitleFromList: opencodeFamilyListedTitle,
  },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--agent full-access',
        planFlag: '--agent plan',
        readOnlyFlag: '--agent ask',
        initialPromptFlag: '--prompt',
        modelFlag: '--model',
        resumeFlag: '--session',
        cliSessionIdFlag: '--session',
        cliSessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '--continue',
        validateProviderSessionId,
      }),
  },
  sessions: { validateProviderSessionId },
  mcp: kilocodeMcpAdapter(),
  plugins: createFileDropPlugin({
    relativePath: KILOCODE_GUGU_EVENT_MODULE_PATH,
    content: KILOCODE_PLUGIN_CONTENT,
    legacyRelativePaths: ['.kilo/plugins/emdash-notifications.js'],
  }),
});
