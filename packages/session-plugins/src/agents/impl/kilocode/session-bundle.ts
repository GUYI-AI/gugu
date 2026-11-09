import { resolveSessionCredentialLifecycle } from '@gugu/session-core/agents/plugins';
import type {
  HarnessSessionSurface,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import {
  OPENCODE_REASONING_VARIANTS,
  openCodeFamilyModelConfig,
  type OpenCodeFamilyModelSpec,
} from '../../helpers/opencode-family-model-config';
import {
  openCodeFamilyPermissionConfig,
  type OpenCodeFamilyPermissionSpec,
} from '../../helpers/opencode-family-permission-config';
import {
  materializeOpenCodeFamilySession,
  type OpenCodeFamilySessionBrand,
} from '../../helpers/opencode-family-session-bundle';
import type { OpenCodeFamilyConfigSpec } from '../../helpers/opencode-family-session-config';
import { KILOCODE_PERMISSION_MODES } from './permission-modes';
import { harnessPlatform } from './platform';
import { KILOCODE_PLUGIN_CONTENT } from './plugin-file';

export const KILOCODE_GUGU_EVENT_MODULE_PATH = '.kilo/plugins/gugu-notifications.js';

const KILO_NATIVE_CONFIG = { kind: 'native', channel: 'process-config' } as const;

/**
 * Kilo is an OpenCode fork, so one env var (`KILO_CONFIG_CONTENT`) carries the whole session.
 *
 * Measured on Kilo 7.8.27 (2026-11-08): isolated HOME, no vendor credentials, bare ACP client, fake
 * OpenAI endpoint, all other egress refused. The endpoint saw `Bearer <config key>` and the configured model
 * (and the new one after a hot switch); the `instructions` file text and project AGENTS.md were in the
 * request; a local MCP tool appeared as `gugu_<tool>` and the call reached the server.
 */
export const kilocodeSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: harnessPlatform,
  // Kilo-Org/kilocode@03a6f07d053cd7e6aa88fa1e258e93510335259f packages/core/src/flag/flag.ts:131
  projectConfigDisableEnv: 'KILO_DISABLE_PROJECT_CONFIG',
  vendorDataOff: {
    env: { KILO_TELEMETRY_LEVEL: 'off', KILO_DISABLE_SESSION_INGEST: '1' },
    evidence:
      'Kilo-Org/kilocode@03a6f07d053cd7e6aa88fa1e258e93510335259f packages/kilo-telemetry/src/telemetry.ts:125 env beats config;'
      + ' packages/opencode/src/kilo-sessions/kilo-sessions.ts:312 ingest off',
  },
  shellEnv: {
    denied: ['KILO_CONFIG', 'KILO_CONFIG_DIR', 'KILO_SERVER_PASSWORD', 'KILO_SERVER_USERNAME'],
  },
  selfUpdate: {
    kind: 'session-env',
    env: { KILO_DISABLE_AUTOUPDATE: '1' },
    evidence: 'Kilo-Org/kilocode@03a6f07d053cd7e6aa88fa1e258e93510335259f packages/core/src/flag/flag.ts:47 KILO_DISABLE_AUTOUPDATE',
  },
  credentialLifecycle: {
    acp: {
      delivery: 'credential-proxy',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'serve-process-descendants',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'replace',
    },
    tui: {
      delivery: 'credential-proxy',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'serve-process-descendants',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'replace',
    },
  },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    acp: { identity: 'addressable', messageTransport: 'router' },
    tui: { identity: 'addressable', messageTransport: 'router', hostAdapter: 'opencode-serve-attach-v1' },
  },
  runtimeCompatibility: {
    acp: { kind: 'semver-supported-floor', supportedFloor: '7.8.27', versionArgs: ['--version'] },
    tui: { kind: 'semver-supported-floor', supportedFloor: '7.8.27', versionArgs: ['--version'] },
  },
  mcpToggle: { dialect: 'config-content-enabled' },
  units: {
    mcp: KILO_NATIVE_CONFIG,
    env: { kind: 'native', channel: 'child-process' },
    model: KILO_NATIVE_CONFIG,
    autonomy: KILO_NATIVE_CONFIG,
    promptBlocks: KILO_NATIVE_CONFIG,
  },
  extension: {
    kind: 'none',
    degraded: {
      code: 'upstream-broken',
      reason: 'Any workspace .kilo/plugins/*.js makes Kilo reach for the npm registry at startup; no leg consumes the module.',
    },
  },
  /**
   * Terminal interrupt: Esc pressed twice. Upstream counts presses and only aborts at two.
   * ⚠️ ❌ Never Ctrl-C: in this family it exits the whole app.
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    presses: 2,
    intervalMs: 120,
    evidence:
      'Kilo-Org/kilocode@03a6f07d053cd7e6aa88fa1e258e93510335259f packages/tui/src/config/keybind.ts:97 '
      + 'session_interrupt=escape; packages/tui/src/component/prompt/index.tsx:453-463 counts presses, '
      + 'session.abort at >=2. :48 app_exit=ctrl+c,ctrl+d',
  },
  coexistence: {
    // The ACP leg is Kilo's own server (`kilo acp`). Cancel measured: `stopReason: cancelled`, process kept.
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    // Measured `session/request_permission` with options. Clarifying questions are not wired in Gugu.
    askUser: { kind: 'native', channel: 'permission-ask' },
    introspection: { kind: 'native', channel: 'config-scan' },
    memory: { kind: 'native', channel: 'agents-md' },
    // todo stays on the base class: this family's ACP bridge has `todowrite` but sends no plan.
  },
} satisfies SessionBundleDescriptor;

export function kilocodeCredentialLifecycle(surface: HarnessSessionSurface) {
  const lifecycle = resolveSessionCredentialLifecycle(kilocodeSessionBundleDescriptor, surface);
  if (!lifecycle) throw new Error(`Kilo credential lifecycle is undeclared for surface '${surface}'`);
  return lifecycle;
}

const KILO_CONFIG_SPEC: OpenCodeFamilyConfigSpec = {
  displayName: 'Kilo',
  configEnvKey: 'KILO_CONFIG_CONTENT',
  runHomeSlug: 'kilocode-capability-runs',
};

const KILO_MODEL_SPEC: OpenCodeFamilyModelSpec = {
  displayName: 'Kilo',
  dialect: 'kilocode-config-content',
  platformProviderId: 'gugu-platform',
  platformProviderName: 'Gugu 平台额度',
  outputLimit: 131_072,
  reasoningVariants: OPENCODE_REASONING_VARIANTS,
};

/** `toolKeys` transcribed from Kilo-Org/kilocode@v7.8.27 packages/core/src/v1/config/permission.ts. */
const KILO_PERMISSION_SPEC: OpenCodeFamilyPermissionSpec = {
  displayName: 'Kilo',
  toolKeys: [
    'read', 'edit', 'glob', 'grep', 'list', 'bash', 'task',
    'external_directory', 'markdown_source', 'todowrite', 'question', 'webfetch', 'websearch',
    'lsp', 'doom_loop', 'skill', 'agent_manager', 'notebook_read', 'notebook_edit', 'notebook_execute',
  ],
  approvalGatedKeys: ['bash', 'webfetch', 'websearch', 'external_directory', 'doom_loop', 'notebook_execute'],
};

const KILO_MODES = KILOCODE_PERMISSION_MODES;
/** Kilo's guard re-applies `<server>_*: ask` after the top-level `permission` rules in these modes. */
const KILO_GUARDED_AGENTS = [KILO_MODES.plan.id, KILO_MODES['read-only'].id];
/** The modes that follow the approval rules. Set per agent so that they still ask in a full-access spawn. */
const KILO_APPROVAL_AGENTS = [KILO_MODES.edit.id, ...KILO_MODES.edit.aliases.filter((id) => id === 'debug')];

function permissionConfig(
  autonomy: SessionCapabilityBundle['autonomy'],
  mcpServers: SessionCapabilityBundle['mcpServers'],
  surface: HarnessSessionSurface,
): Record<string, unknown> {
  if (!autonomy) return {};
  const fullAccess = (autonomy.permissionMode ?? autonomy.mode) === 'full-access';
  const approvalRules = openCodeFamilyPermissionConfig(KILO_PERMISSION_SPEC, { ...autonomy, mode: 'approval-required' })
    .permission as Record<string, string>;
  // Without this every Gugu tool call, including a chat reply, waits for approval in plan and read-only:
  // `getMcpRules` asks for each server, and only `agent.<name>.permission` merges after that guard
  // (measured 7.8.27). Servers the user configured themselves keep asking.
  const guguTools = Object.fromEntries(
    mcpServers
      .filter((server) => server.owner !== 'user')
      .map((server) => [`${server.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_*`, 'allow']),
  );
  // @@@kilo-subagent-approval — Kilo's ACP drops a subagent's permission request (`acp/permission.ts:54-55`:
  // no session for the child id, return), so the turn hangs forever (measured 7.8.27). The top-level rules are what
  // subagents follow, so: full access stays `allow`, and over ACP an approval tier denies those tools in the
  // built-in subagents, which fails loud. The terminal leg can answer subagent prompts and keeps asking.
  // explore keeps `bash` out of it: its bash is already capped to a read-only allowlist that never asks
  // (`exploreBash`), and a deny here would survive that cap and take away `ls`.
  // ❌ No `scout` entry: it is not registered by default, and naming it here would create a new agent (measured).
  const denied = (keys: readonly string[]) => ({ permission: Object.fromEntries(keys.map((key) => [key, 'deny'])) });
  const gated = Object.keys(approvalRules);
  const subagentRules = !fullAccess && surface === 'acp'
    ? { general: denied(gated), explore: denied(gated.filter((key) => key !== 'bash')) }
    : {};
  return {
    permission: fullAccess ? 'allow' : approvalRules,
    agent: {
      ...Object.fromEntries(KILO_GUARDED_AGENTS.map((id) => [id, { permission: guguTools }])),
      ...Object.fromEntries(KILO_APPROVAL_AGENTS.map((id) => [id, { permission: approvalRules }])),
      // A real mode, so the pill shows full access and leaving it really brings approvals back.
      [KILO_MODES['full-access'].id]: {
        mode: 'primary',
        description: 'Runs every tool without asking.',
        permission: { '*': 'allow' },
      },
      ...subagentRules,
    },
  };
}

function sessionCreatePatch(autonomy: SessionCapabilityBundle['autonomy']): Readonly<{ agent?: string }> | undefined {
  const mode = autonomy?.permissionMode ?? (autonomy?.mode === 'full-access' ? 'full-access' : undefined);
  return mode === 'plan' || mode === 'read-only' || mode === 'full-access' ? { agent: KILO_MODES[mode].id } : undefined;
}

const KILO_SESSION_BRAND: OpenCodeFamilySessionBrand = {
  adapterId: 'kilocode',
  configSpec: KILO_CONFIG_SPEC,
  surfaces: kilocodeSessionBundleDescriptor.surfaces,
  credentialLifecycle: kilocodeCredentialLifecycle,
  modelConfig: (model) => openCodeFamilyModelConfig(KILO_MODEL_SPEC, model),
  permissionConfig,
  sessionCreatePatch,
  eventModulePath: KILOCODE_GUGU_EVENT_MODULE_PATH,
  eventModuleContent: KILOCODE_PLUGIN_CONTENT,
  // With a Kilo login, title and other small requests go to Kilo's gateway even on a Gugu model (measured 7.8.27).
  smallModelFollowsProvider: 'gugu-platform',
  eventModuleRetiredReason:
    'Kilo treats any workspace .kilo/plugins/*.js as a plugin origin and reaches for the npm registry at startup; '
    + 'neither session surface consumes the module, so it is retired rather than materialized.',
};

export function materializeKilocodeSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle,
): SessionMaterialization {
  return materializeOpenCodeFamilySession(KILO_SESSION_BRAND, ctx, bundle);
}
