import {
  definePlugin,
  registerPluginBehavior,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { ANTIGRAVITY_CLI_COMPANION } from '../antigravity';
import { antigravityCliAuthStatus } from '../antigravity/auth';
import { icon } from '../antigravity/icon';
import { antigravityMcpAdapter } from '../antigravity/mcp';
import { readAntigravityRules } from '../antigravity/rules';
import { discoverAntigravitySkills } from '../antigravity/skills';
import { antigravitySubscriptionBehavior } from '../antigravity/subscription';
import {
  antigravitySessionBundleDescriptor,
  materializeAntigravitySessionBundle,
  withLoopbackNoProxy,
} from '../antigravity/session-bundle';

/**
 * A separate provider deliberately preserves the existing `antigravity` conversations and login. The official
 * standalone server and `agy acp` use different stores (`antigravity-acp` and `antigravity-cli`); replacing the binary
 * behind the old id would try to load existing conversations in the wrong store.
 *
 * Google CLI 1.5.1 removed the editor allowlist for non-Gemini models:
 * https://antigravity.google/docs/changelog?tab=cli&version=1.5.1
 * Measured on agy 1.5.10: session/new lists Carbon, Argon, Hydrogen, Claude 5.5 and Orchestrator, plus independent
 * model/thought_level/mode configOptions. Model ids always come from that response, never from a Gugu table.
 */
const enabled = process.platform !== 'win32';
const sessionBundle = {
  ...antigravitySessionBundleDescriptor,
  // The explicit vendor flag moves the config root without changing HOME for commands the agent executes.
  configRoot: {
    ...antigravitySessionBundleDescriptor.configRoot,
    evidence: 'agy 1.5.10 `acp --help`: --gemini-dir sets the Gemini files directory; isolated-root ACP probe verified 2026-11-17.',
  },
  surfaces: enabled ? ['acp'] : [],
  sessionpage: enabled ? { acp: antigravitySessionBundleDescriptor.sessionpage.acp } : {},
  runtimeCompatibility: {
    acp: { kind: 'semver-supported-floor', supportedFloor: '1.5.1', versionArgs: ['--version'] },
  },
  units: {
    ...antigravitySessionBundleDescriptor.units,
    mcp: { kind: 'native', channel: 'acp-session' },
    promptBlocks: { kind: 'native', channel: 'session-context' },
  },
  // No terminal surface here; the existing provider continues to own that integration.
  sessionTuiInterrupt: undefined,
} satisfies SessionBundleDescriptor;

function geminiDir(env: Readonly<Record<string, string>>): string {
  const root = env.GEMINI_HOME?.trim();
  if (!root) throw new Error('Antigravity CLI ACP requires the managed GEMINI_HOME');
  return root;
}

const liveSetting = { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none' } as const;

export const plugin = definePlugin({
  id: 'antigravity-cli-acp',
  name: 'Antigravity CLI',
  description: 'Google Antigravity CLI, with the current models available to your Google account.',
  websiteUrl: 'https://antigravity.google/docs/cli/acp/',
}, {
  sessionBundle,
  hostDependency: ANTIGRAVITY_CLI_COMPANION.dependency,
  acp: {
    kind: 'supported',
    liveSettings: { model: liveSetting, permission: liveSetting, effort: liveSetting },
  },
  autoApprove: {
    kind: 'supported',
    modesExhaustive: true,
    // These are the vendor's reported ids. `auto` is not an unconditional full-access mode.
    modes: { 'read-only': { id: 'default' }, edit: { id: 'accept-edits' } },
  },
  auth: {
    kind: 'supported',
    methods: [{ kind: 'acp-authenticate', id: 'google', name: 'Google account', methodId: 'oauth-personal' }],
  },
  subscription: { kind: 'supported', usageRefresh: 'on-open' },
  mcp: { kind: 'supported', scope: 'global', supportedTransports: ['stdio', 'http'], sessionUserServers: 'inherit', toolNames: { kind: 'unmeasured' } },
  sessions: { kind: 'resumable' },
  trust: { kind: 'none' },
  prompt: { kind: 'none', reason: 'This provider uses the official CLI ACP server in the chat panel.' },
}, { icon });

export const provider = registerPluginBehavior(plugin, {
  auth: {
    checkStatus: antigravityCliAuthStatus,
  },
  subscription: antigravitySubscriptionBehavior(),
  sessionBundle: {
    materialize: (ctx, bundle) => {
      if (ctx.surface !== 'acp') throw new Error(`Antigravity CLI ACP does not support '${ctx.surface}'`);
      const result = materializeAntigravitySessionBundle(ctx, bundle);
      return { ...result, report: { ...result.report, adapterId: 'antigravity-cli-acp' } };
    },
  },
  mcp: antigravityMcpAdapter(),
  acp: {
    ...createNativeAcpBehavior(ctx => ({
      args: ['acp', '--stdio', '--gemini-dir', geminiDir(ctx.env)],
      env: withLoopbackNoProxy(ctx.env),
    }), { interruptAtToolBoundary: true }),
    // `set_config_option` acknowledges the family id; effort is its own config option, not a model-id suffix.
    catalogModelSource: 'config-options',
    discoverCommands: discoverAntigravitySkills,
    readRules: readAntigravityRules,
  },
});
