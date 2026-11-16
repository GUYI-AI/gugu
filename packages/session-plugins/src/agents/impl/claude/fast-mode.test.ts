import { describe, expect, it } from 'vitest';
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

  it.each([true, false])('delivers explicit %s in native ACP startup without a platform model', (fastMode) => {
    const materialized = materializeClaudeSessionBundle({ surface: 'acp', lifecycle: 'fresh', cwd: '/fixture' }, {
      mcpServers: [], env: {}, model: { dialect: 'provider-env', fastMode },
      autonomy: null, promptBlocks: {}, packages: [],
    });
    if (fastMode) expect(materialized.acp?.meta).toMatchObject({ claudeCode: { options: { settings: { fastMode: true } } } });
    else expect((materialized.acp?.meta as {claudeCode?: {options?: Record<string, unknown>}})?.claudeCode?.options).not.toHaveProperty('settings');
    expect(materialized.argsAppend).toEqual([]);
    expect(materialized.env).toEqual({});
  });

  it('keeps ACP Fast and UltraCode together without copying protected credentials into settings', () => {
    const materialized = materializeClaudeSessionBundle({ surface: 'acp', lifecycle: 'fresh', cwd: '/fixture' }, {
      mcpServers: [], env: {}, model: {
        dialect: 'provider-env', fastMode: false, reasoningEffort: 'ultracode',
        platformSettingsEnv: { ANTHROPIC_AUTH_TOKEN: 'fixture-token' },
      }, autonomy: null, promptBlocks: {}, packages: [],
    });
    expect(materialized.acp?.meta).toMatchObject({ claudeCode: { options: { settings: { ultracode: true } } } });
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
