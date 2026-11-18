import { describe, expect, it } from 'vitest';
import { acpSessionMetaSchema } from '@gugu/session-core/acp';
import { provider } from './index';
import { platformModel } from './platform-model';
import { materializeClaudeSessionBundle } from './session-bundle';

describe('Claude session Fast settings', () => {
  it('declares native acknowledged updates queued for the next turn', () => {
    expect(provider.capabilities.acp.liveSettings?.fast).toEqual({
      channel: 'acp-config-option', ack: 'ack-read-back', busy: 'queue-next-turn',
      reloadRequired: false, recovery: 'none',
    });
  });

  it.each([true, false])('passes explicit %s to the native startup settings without replacing model/env', (fastMode) => {
    const model = { dialect: 'provider-env' as const, model: 'opus', fastMode };
    expect(platformModel.load(model)).toEqual({
      spawnEnv: { ANTHROPIC_MODEL: 'opus' },
      settingsOverride: { fastMode },
    });
  });

  it('carries explicit off even when the native model is left to the CLI', () => {
    const model = { dialect: 'provider-env' as const, fastMode: false };
    expect(platformModel.load(model)).toEqual({ settingsOverride: { fastMode: false } });
  });

  // The ACP leg's Fast is the `fast` config option armed at startup (SessionManager.applyInitialFastMode).
  // `options.settings` crosses the main→runtime wire as a settings-file path; an inline document there is
  // rejected by the wire schema before the adapter is spawned, so every native Claude session stalled.
  it.each([
    ['Fast on', { dialect: 'provider-env' as const, fastMode: true }],
    ['Fast off', { dialect: 'provider-env' as const, fastMode: false }],
    ['UltraCode with a protected document', {
      dialect: 'provider-env' as const, fastMode: false, reasoningEffort: 'ultracode',
      platformSettingsEnv: { ANTHROPIC_AUTH_TOKEN: 'fixture-token' },
    }],
  ])('native ACP startup meta (%s) crosses the runtime wire', (_label, model) => {
    const materialized = materializeClaudeSessionBundle({ surface: 'acp', lifecycle: 'fresh', cwd: '/fixture' }, {
      mcpServers: [], env: {}, model, autonomy: null, promptBlocks: {}, packages: [],
    });
    const meta = materialized.acp?.meta;
    expect(acpSessionMetaSchema.safeParse(meta).success).toBe(true);
    expect(meta).not.toHaveProperty(['claudeCode', 'options', 'settings']);
    expect(materialized.argsAppend).toEqual([]);
    expect(JSON.stringify(materialized)).not.toContain('fixture-token');
  });

  it('preserves legacy materialization when no session Fast intent is supplied', () => {
    expect(platformModel.load({ dialect: 'provider-env' })).toEqual({});
    expect(platformModel.load({ dialect: 'provider-env', model: 'opus' })).toEqual({ spawnEnv: { ANTHROPIC_MODEL: 'opus' } });
  });

  it('merges Fast off into an existing protected model/environment document', () => {
    const model = {
      dialect: 'provider-env' as const, model: 'platform-claude', fastMode: false,
      platformSettingsEnv: { ANTHROPIC_AUTH_TOKEN: 'fixture-token', ANTHROPIC_BASE_URL: 'https://fixture.invalid' },
    };
    expect(platformModel.load(model).settingsOverride).toMatchObject({
      fastMode: false,
      env: { ANTHROPIC_AUTH_TOKEN: 'fixture-token', ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_MODEL: 'platform-claude' },
    });
  });

  it('materializes UltraCode and Fast in the same document for the host settings writer', () => {
    const declared = platformModel.declare({
      explicitModel: 'opus', requestedEffort: 'ultracode', envOverride: () => undefined,
      platformProvider: undefined, platformAccess: undefined, platformModels: undefined,
      contextWindow: undefined, callableRoutes: {}, protocolEnv: () => ({}),
    });
    const model = { ...declared, fastMode: true };
    expect(platformModel.load(model).settingsOverride).toEqual({ fastMode: true, ultracode: true });
  });

  it.each([true, false])('sends %s through the non-interactive command settings', (fastMode) => {
    const ctx = { cli: '/fixture/claude', model: 'opus', fastMode, permissionMode: 'read-only' as const };
    const command = provider.behavior.prompt!.buildCommand(ctx);
    const index = command.args.indexOf('--settings');
    expect(index).toBeGreaterThan(-1);
    expect(JSON.parse(command.args[index + 1])).toEqual({ fastMode });
    expect(command.args.filter((arg) => arg === '--settings')).toHaveLength(1);
  });

  it('keeps Fast independent of UltraCode in one settings object', () => {
    const ctx = { cli: '/fixture/claude', model: 'opus', effort: 'ultracode', fastMode: true, permissionMode: 'read-only' as const };
    const command = provider.behavior.prompt!.buildCommand(ctx);
    const index = command.args.indexOf('--settings');
    expect(JSON.parse(command.args[index + 1])).toEqual({ ultracode: true, fastMode: true });
    expect(command.args).not.toContain('--effort');
  });

  it.each([
    ['--settings', '/fixture/session-settings.json'],
    ['--settings=/fixture/session-settings.json'],
  ])('preserves caller-owned settings %j instead of appending an overriding flag', (...extraArgs) => {
    const originalArgs = [...extraArgs];
    const ctx = { cli: '/fixture/claude', model: 'opus', effort: 'ultracode', fastMode: true, extraArgs, permissionMode: 'read-only' as const };
    const command = provider.behavior.prompt!.buildCommand(ctx);
    expect(command.args.filter((arg) => arg === '--settings' || arg.startsWith('--settings='))).toHaveLength(1);
    expect(command.args).toEqual(expect.arrayContaining(originalArgs));
    expect(extraArgs).toEqual(originalArgs);
  });
});
