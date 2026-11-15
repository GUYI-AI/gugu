import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import { miseDependency } from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { KIRO_LOGIN_METHOD_ID, kiroAuthStatus } from './auth';
import { icon } from './icon';
import { kiroMcpAdapter } from './mcp';
import { preApproveGuguTool } from './pre-approve';
import { KIRO_PERMISSION_MODES } from './permission-modes';
import { kiroSessionBundleDescriptor, materializeKiroSessionBundle } from './session-bundle';

const sessionBundle = kiroSessionBundleDescriptor satisfies SessionBundleDescriptor;

/**
 * Managed install from the official ACP registry entry `kiro` (per-platform archives with sha256). The one binary is
 * also Kiro's sign-in program, so the launcher stays a plain `kiro-cli` (`registryArgs: 'omit'`) and the ACP leg below
 * passes `acp --agent-engine=v3` itself. A copy the user installed from cli.kiro.dev is recognised by the same name.
 *
 * The registry publishes no Windows build, so Windows has no install command: the UI points at the install docs
 * instead of offering a button that can only fail.
 */
const managed = miseDependency({
  id: 'kiro-cli',
  backend: 'acp-registry',
  agentId: 'kiro',
  registryArgs: 'omit',
  installDocs: 'https://kiro.dev/docs/cli/installation/',
});
const { windows: _noWindowsPackage, ...installCommands } = managed.installCommands;

export const plugin = definePlugin(
  {
    id: 'kiro',
    name: 'Kiro',
    description:
      'Kiro CLI by AWS, focused on interactive terminal-first development assistance and workflow automation.',
    websiteUrl: 'https://kiro.dev/docs/cli/',
  },
  {
    sessionBundle,
    /** Signed out, `session/new` answers -32000 "Authentication required" and no third-party key can replace the account. */
    vendorAccount: {
      kind: 'required',
      evidence:
        'kiro-cli 3.0.0 isolated HOME: session/new -32000 Authentication required; inference only reaches Kiro\'s own service (see units.model)',
    },
    acp: {
      kind: 'supported',
      // Kiro's `modes` are agent configs (vibe, spec, plan, ...), not permission tiers.
      sessionModes: 'none',
      // The first session unpacks the bundled agent server.
      startup: { noticeKey: 'chat.kiroPreparing' },
      liveSettings: {
        model: { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none' },
        // Presets are seeded when a session is opened and cannot be withdrawn (kiro.dev/docs/permissions), so changing
        // tier means reopening the session with the new preset.
        permission: { channel: 'reload-session', ack: 'none', busy: 'reject', reloadRequired: true, recovery: 'runtime-restart' },
        // The free-tier models report no `effortLevel`; not measured on a model that has one.
        effort: { channel: 'unsupported', ack: 'none', busy: 'reject', reloadRequired: false, recovery: 'unsupported' },
      },
    },
    autoApprove: {
      kind: 'supported',
      modes: KIRO_PERMISSION_MODES,
      modesExhaustive: true,
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: KIRO_LOGIN_METHOD_ID,
          name: 'Kiro account',
          args: ['login'],
          headlessArgs: ['login', '--use-device-flow'],
          description: 'Runs `kiro-cli login`: Builder ID, Identity Center, Google or GitHub.',
        },
      ],
    },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      // V3 loads MCP tools on demand: the model calls `tool_load`, then `tool_call {tool_id:'gugu::<tool>'}`.
      toolNames: {
        kind: 'proxied',
        prefix: 'gugu::',
        proxyTool: 'tool_call',
        evidence: 'kiro-cli 3.0.0 real turn 2026-11-08: usedTools [tool_load, tool_call], rawInput {"tool_id":"gugu::ping_probe"}',
      },
    },
    trust: { kind: 'none' },
    hostDependency: {
      ...managed,
      installCommands,
      // Unlike a pure ACP server, this binary answers `--version` without side effects.
      skipVersionProbe: false,
      versionLine: /^kiro-cli \d/,
    },
    // agent memory —— kiro 的 steering 一族 + 它兼容的 AGENTS.md。
    // 出处:https://kiro.dev/docs/steering/(取证 2026-08-24)。原文要点:
    //  ·「On Kiro CLI, inclusion modes are not currently supported. All steering files in the
    //    `.kiro/steering/` directory are loaded automatically.」→ CLI 上是**无条件全量加载**,
    //    所以整目录登记(只收顶层 `.md`)。
    //  · 全局 steering 在 `~/.kiro/steering/`,workspace steering 在项目根 `.kiro/steering/`;
    //    两处冲突时 workspace 优先。
    //  · AGENTS.md 可放 `~/.kiro/steering/` 或 workspace 根,且「AGENTS.md files do not support
    //    inclusion modes and are always included.」
    // ⚠️ 子目录里的 AGENTS.md(官方说也会在项目子目录中发现)**没登记**:`AgentMemoryEntry`
    //    表达不了「整棵树递归找」,硬写一层是猜。少登记只是欠账。
    // ⚠️ 放在 `~/.kiro/steering/` 的 AGENTS.md 不另立条目 —— 它已经被上面那条 global 目录条目
    //    按 `.md` 后缀收进来了。
    // ⚠️ `satisfies` 不是装饰,理由同 sessionBundle(zod 4 的 ZodType Input 是 unknown)。
    memory: {
      kind: 'files',
      entries: [
        {
          kind: 'directory',
          scope: 'global',
          channel: 'vendor-file',
          path: '.kiro/steering',
          suffixes: ['.md'],
        },
        {
          kind: 'directory',
          scope: 'project',
          channel: 'vendor-file',
          path: '.kiro/steering',
          suffixes: ['.md'],
        },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    prompt: {
      kind: 'none',
      reason: 'Gugu offers Kiro only as a Work (ACP) session; its terminal UI is not offered.',
    },
    // V3 stores sessions itself; `initialize` reports `loadSession: true`.
    sessions: { kind: 'resumable' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  auth: { checkStatus: kiroAuthStatus },
  sessionBundle: { materialize: materializeKiroSessionBundle },
  mcp: kiroMcpAdapter(),
  acp: {
    ...createNativeAcpBehavior(() => ({
      args: ['acp', '--agent-engine=v3'],
      // Left alone, Kiro replaces its own binary in place on startup (measured: the 3.0.0 mise install reported 3.1.0
      // after the first session). The version that runs is the one Gugu installed; updates go through mise.
      env: { KIRO_NO_AUTO_UPDATE: '1' },
    }), {
      preApprove: preApproveGuguTool,
      // Kiro sends `terminal/create` with the whole shell line in `command` and no `args`, which its own host runs
      // through the user's shell; Gugu's client terminal spawns `command` as a program. Measured on 3.0.0: every shell
      // call failed with `spawn <line> ENOENT`. Without the capability Kiro runs commands itself and reports the output.
      ownTerminal: true,
    }),
    catalogModelsInConfigUpdate: true,
    // Measured on 3.0.0: `<｜DSML｜function_calls` shows in the reply before each tool call; the call itself runs.
    modelsLeakingToolCallMarkers: ['deepseek-3.2'],
  },
});
