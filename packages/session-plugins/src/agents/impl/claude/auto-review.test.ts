import { acpSessionMetaSchema } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { claudeAutoReviewAvailable, claudeReviewConfig, CLAUDE_REVIEWER_MODEL, claudeReviewSettings } from './auto-review';
import { provider } from './index';
import { materializeClaudeSessionBundle } from './session-bundle';

const options = (model: string, description?: string): SessionConfigOption[] => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: model, name: model, description }] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'acceptEdits', options: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'].map(value => ({ value, name: value })) },
];
const modes = (version: string | undefined, model: string, description?: string) => {
  const mode = claudeReviewConfig(options(model, description), version)[1]!;
  return mode.type === 'select' ? mode.options : [];
};
describe('Claude AI review prerequisites', () => {
  it('pins the reviewer over a user settings env while preserving unrelated keys and source', () => {
    const source = { fastMode: true, env: { CUSTOM: 'kept', CLAUDE_CODE_AUTO_MODE_MODEL: 'user-reviewer' } };
    expect(claudeReviewSettings(source)).toEqual({ fastMode: true, env: { CUSTOM: 'kept', CLAUDE_CODE_AUTO_MODE_MODEL: CLAUDE_REVIEWER_MODEL } });
    expect(source.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe('user-reviewer');
  });
  it.each([undefined, '', '2.1.293', '2.1.301', 'unknown', '1.9.999', '2.1.302-beta'])('hides auto for unverified/old actual CLI %s', version => {
    expect(modes(version, 'claude-opus-5')).not.toContainEqual({ value: 'auto', name: 'auto' });
  });
  it.each(['2.1.302', '2.1.311', '2.2.0', '3.0.0'])('accepts actual CLI %s at or after the floor', version => {
    expect(claudeAutoReviewAvailable(version, 'claude-opus-5')).toBe(true);
  });
  it.each(['opus', 'opus[1m]', 'claude-opus-5', 'claude-fable-5-1[1m]', 'fable', 'claude-sonnet-4-6', 'claude-sonnet-5-1', 'claude-sonnet-5', 'claude-haiku-5-5'])('allows supported main model %s', model => {
    expect(claudeAutoReviewAvailable('2.1.302', model)).toBe(true);
  });
  it.each(['sonnet', 'deepseek-v4', 'glm-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'haiku', '', 'default', 'proxy/claude-opus-5'])('does not infer support for %s', model => {
    expect(claudeAutoReviewAvailable('2.1.311', model)).toBe(false);
  });
  it('resolves default from native model facts and preserves other modes', () => {
    expect(modes('2.1.311', 'default', 'Claude Opus 5')).toHaveLength(5);
    expect(modes('2.1.311', 'default', 'DeepSeek V4')).toHaveLength(4);
    expect(modes('2.1.301', 'default', 'Claude Opus 5')).toHaveLength(4);
    expect(modes('2.1.311', 'sonnet', 'Claude Sonnet 4.6')).toHaveLength(5);
    expect(modes('2.1.311', 'sonnet', 'Claude Sonnet 4.5')).toHaveLength(4);
    expect(modes('2.1.311', 'sonnet')).toHaveLength(4);
    expect(modes('2.1.311', 'sonnet[1m]', 'Claude Sonnet 4.6')).toHaveLength(5);
  });
  it('sends native auto rather than the bypass flag', () => {
    const command = provider.behavior.prompt!.buildCommand({ cli: '/fixture/claude', model: 'claude-opus-5', permissionMode: 'ai-review' });
    expect(command.args).toContain('auto');
    expect(command.args).not.toContain('--dangerously-skip-permissions');
    expect(command.autoApproved).not.toBe(true);
    expect(JSON.parse(command.args[command.args.indexOf('--settings') + 1])).toMatchObject({ env: { CLAUDE_CODE_AUTO_MODE_MODEL: CLAUDE_REVIEWER_MODEL } });
  });
  it.each(['acp', 'tui'] as const)('pins Haiku on the %s session materialization, without changing host CLI', surface => {
    const result = materializeClaudeSessionBundle({ surface, lifecycle: 'fresh', cwd: '/fixture' }, { mcpServers: [], env: { GUGU_HOME: '/fixture/gugu' }, model: null, autonomy: { permissionMode: 'ai-review' }, promptBlocks: {}, packages: [] });
    expect(result.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe(CLAUDE_REVIEWER_MODEL);
    if (surface === 'acp') {
      const artifact = result.artifacts.find(file => file.path.endsWith(`${CLAUDE_REVIEWER_MODEL}.json`));
      expect(artifact).toMatchObject({ mode: 0o600 });
      expect(JSON.parse(artifact!.content)).toEqual({ env: { CLAUDE_CODE_AUTO_MODE_MODEL: CLAUDE_REVIEWER_MODEL } });
      expect(result.acp?.meta).toMatchObject({ claudeCode: { options: { settings: artifact!.path } } });
    }
  });
});

it('uses a settings-file path on the native ACP wire even when AI review is enabled later', () => {
  const result = materializeClaudeSessionBundle({ surface: 'acp', lifecycle: 'fresh', cwd: '/fixture' }, {
    mcpServers: [], env: { GUGU_HOME: '/fixture/gugu' }, model: null, autonomy: { permissionMode: 'edit' }, promptBlocks: {}, packages: [],
  });
  expect(acpSessionMetaSchema.safeParse(result.acp?.meta).success).toBe(true);
  expect(result.acp?.meta).toMatchObject({ claudeCode: { options: { settings: expect.any(String) } } });
});
