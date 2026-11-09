import type {
  Degradation,
  NativeHome,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import { PLATFORM_NOT_WIRED } from '@gugu/session-core/agents/plugins';
import { resolveDeclaredPermissionMode } from '@gugu/session-core/acp';
import { sessionPromptText } from '../../helpers/session-bundle';
import { sessionMcpProtocolServers } from '../../helpers/session-mcp';
import { KIRO_PERMISSION_MODES, KIRO_POLICY_PRESETS } from './permission-modes';

/**
 * The version this file's readings come from, the ACP registry's `kiro` entry. V3 is the engine the registry launches
 * (`acp --agent-engine=v3`) and the one the vendor develops; V2 receives no new features (kiro.dev/docs/cli/agent-harness).
 */
export const KIRO_CLI_VERSION = '3.0.0';

/**
 * A final answer, not a gap. Measured on kiro-cli 3.0.0, V3 engine, fake key, local recording endpoint:
 *  - ACP `providers/list` and `providers/set` answer -32601 Method not found: no provider switch over ACP.
 *  - The undocumented KIRO_KAS_ENDPOINT / KIRO_KAS_CONTROL_PLANE_ENDPOINT do move the traffic, but it stays Kiro's
 *    private protocol: `application/x-amz-json-1.0` + `x-amz-target`, with inference at
 *    `KiroRuntimeService.GenerateAssistantResponse` answered as `application/vnd.amazon.eventstream`.
 *  - The binary and its agent bundle have no `/v1/messages`, `/v1/chat/completions`, `api.anthropic.com`,
 *    `anthropic-version` or ANTHROPIC_/OPENAI_ environment variables. Positive control on the same search:
 *    `GenerateAssistantResponse` and `runtime.us-east-1.kiro.dev` are found.
 * Reaching the Gugu gateway would mean impersonating Kiro's backend and converting formats, which the gateway does not do.
 */
const vendorClosedModel: Degradation = {
  code: 'unsupported-channel',
  reason:
    `kiro-cli ${KIRO_CLI_VERSION} only speaks Kiro's private AWS JSON 1.0 + event-stream protocol for inference `
    + '(KiroRuntimeService.GenerateAssistantResponse), has no Anthropic- or OpenAI-compatible path, and answers ACP '
    + 'providers/set with Method not found. Sessions use the user\'s own Kiro account and credits.',
};

/** Same as dsh: Apps reach Kiro as MCP servers in session/new and through the <gugu_apps> platform block. */
const noNativePackage: Degradation = {
  code: 'unsupported-channel',
  reason: 'Gugu ships no native plugin package for Kiro and needs none: installed Apps reach it as MCP servers in '
    + 'session/new and through the <gugu_apps> platform block.',
};

export const kiroSessionBundleDescriptor = {
  injectionMode: 'runtime',
  nativeHome: {
    envVar: 'KIRO_HOME',
    userPath: '.kiro',
    evidence: 'kiro-cli 3.0.0: KIRO_HOME moves settings, agents and sessions; the login store stays in XDG_DATA_HOME/kiro-cli (2026-11-08)',
  } satisfies NativeHome,
  platform: PLATFORM_NOT_WIRED,
  surfaces: ['acp'],
  sessionpage: {
    'acp': { identity: 'addressable', messageTransport: 'router' },
  },
  /** `acp --agent-engine=v3` and `_meta.kiro.policyPreset` are what this adapter relies on, measured from this version. */
  runtimeCompatibility: {
    'acp': { kind: 'semver-supported-floor', supportedFloor: KIRO_CLI_VERSION, versionArgs: ['--version'] },
  },
  units: {
    /** `session/new.mcpServers`. Measured: `_kiro/mcp/status` reaches `connected` and the tools register. */
    mcp: { kind: 'native', channel: 'acp-session' },
    env: { kind: 'native', channel: 'child-process' },
    model: { kind: 'none', degraded: vendorClosedModel },
    /** The session's policy presets, in `_meta.kiro.policyPreset` on `session/new` and `session/load` (./permission-modes.ts). */
    autonomy: { kind: 'native', channel: 'session-mode' },
    /** A vendor ACP server ignores `_meta.systemPrompt.append`, so identity rides the first user turn (same as dsh). */
    promptBlocks: { kind: 'native', channel: 'session-context' },
  },
  extension: { kind: 'none', degraded: noNativePackage },
  coexistence: {
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    // `.kiro/steering/*.md` is Kiro's own memory, always loaded by the CLI; AGENTS.md is the one it also reads.
    memory: { kind: 'native', channel: 'vendor-file' },
  },
} satisfies SessionBundleDescriptor;

export function materializeKiroSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (ctx.surface !== 'acp') {
    throw new Error(`Kiro session adapter does not support surface '${ctx.surface}'`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  // Same resolution as the registry's terminal path: the nearest tier that is not looser, or refuse to start.
  const wanted = bundle.autonomy?.permissionMode
    ?? (bundle.autonomy?.mode === 'full-access' ? 'full-access' : bundle.autonomy ? 'edit' : undefined);
  const tier = wanted ? resolveDeclaredPermissionMode(wanted, KIRO_PERMISSION_MODES) : undefined;
  if (wanted && !tier) throw new Error(`Kiro has no permission mode for '${wanted}' or any stricter one`);
  const presets = tier ? KIRO_POLICY_PRESETS[KIRO_PERMISSION_MODES[tier as keyof typeof KIRO_PERMISSION_MODES].id] : undefined;

  const prompt = sessionPromptText(bundle.promptBlocks);
  // The token travels in the ACP entry's header, not in the adapter's environment.
  for (const server of bundle.mcpServers) {
    if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
  }
  const loaded = { status: 'loaded' as const };
  return {
    argsAppend: [],
    env,
    acp: {
      mcpServers: sessionMcpProtocolServers(bundle, 'Kiro'),
      ...(presets ? { meta: { kiro: { policyPreset: [...presets] } } } : {}),
    },
    // `carrier` must be explicit: absent means the system slot, which a vendor ACP server ignores.
    ...(prompt ? { prompt: { ...prompt, carrier: 'session-context' as const } } : {}),
    configMerges: [],
    artifacts: [],
    report: {
      adapterId: 'kiro',
      surface: ctx.surface,
      units: {
        mcp: bundle.mcpServers.length > 0
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No MCP server was declared.' } },
        env: loaded,
        model: { status: 'degraded', reason: vendorClosedModel },
        autonomy: presets
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No autonomy level was declared.' } },
        promptBlocks: prompt
          ? loaded
          : { status: 'degraded', reason: { code: 'unverified', reason: 'No prompt blocks were declared.' } },
        packages: { status: 'degraded', reason: noNativePackage },
      },
      discoveredCommands: [],
    },
  };
}
