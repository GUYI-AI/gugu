import { acpSessionMetaSchema, catalogAllowsAutoReview, flattenSelectOptions } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { claudeAutoReviewAvailable, claudeReviewConfig, CLAUDE_REVIEWER_MODEL, claudeReviewSettings } from './auto-review';
import { provider } from './index';
import { materializeClaudeSessionBundle } from './session-bundle';
import { CLAUDE_PERMISSION_MODES } from './permission-modes';

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
  it.each(['opus', 'opus[1m]', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-5', 'claude-fable-5-1[1m]', 'fable', 'claude-sonnet-4-6', 'claude-sonnet-5-1', 'claude-sonnet-5', 'claude-haiku-5-5'])('allows supported main model %s', model => {
    expect(claudeAutoReviewAvailable('2.1.302', model)).toBe(true);
  });
  it.each(['claude-opus-4-5', 'opus-4-5[1m]', 'claude-opus-3', 'claude-opus-4', 'sonnet', 'deepseek-v4', 'glm-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'haiku', '', 'default', 'proxy/claude-opus-5'])('does not infer support for %s', model => {
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
  it.each([
    ['default', 'Claude Opus 5'], ['sonnet', 'Claude Sonnet 4.6'],
    ['sonnet[1m]', 'Claude Sonnet 4.6'], ['haiku', 'Claude Haiku 5.5'],
  ])('keeps native-qualified %s available at the shared own-account creation gate', (model, description) => {
    const native = claudeReviewConfig(options(model, description), '2.1.322');
    const mode = native.find(option => option.category === 'mode');
    const autoReview = mode?.type === 'select' && flattenSelectOptions(mode.options).some(choice => choice.value === 'auto');
    expect(autoReview).toBe(true);
    const catalog = { kind: 'ready', selected: model, autoReview, cliVersion: '2.1.322' };
    expect(catalogAllowsAutoReview(CLAUDE_PERMISSION_MODES, catalog, 'own', model)).toBe(true);
    expect(catalogAllowsAutoReview(CLAUDE_PERMISSION_MODES, catalog, 'own', 'stale-selection')).toBe(false);
    expect(catalogAllowsAutoReview(CLAUDE_PERMISSION_MODES, { ...catalog, kind: 'auth-required' }, 'own', model)).toBe(false);
  });
  it.each([
    ['2.1.301', 'sonnet', 'Claude Sonnet 4.6'], [undefined, 'sonnet', 'Claude Sonnet 4.6'],
    ['2.1.322', 'sonnet', 'Claude Sonnet 4.5'], ['2.1.322', 'sonnet', ''],
    ['2.1.322', 'haiku', 'Claude Haiku 4.5'], ['2.1.322', 'default', 'DeepSeek V4'],
  ])('keeps unqualified native facts hidden at creation (%s / %s / %s)', (version, model, description) => {
    const native = claudeReviewConfig(options(model!, description), version);
    const mode = native.find(option => option.category === 'mode');
    const autoReview = mode?.type === 'select' && flattenSelectOptions(mode.options).some(choice => choice.value === 'auto');
    expect(autoReview).toBe(false);
    expect(catalogAllowsAutoReview(CLAUDE_PERMISSION_MODES,
      { kind: 'ready', selected: model, autoReview, cliVersion: version }, 'own', model)).toBe(false);
  });
  it('sends native auto rather than the bypass flag', () => {
    const command = provider.behavior.prompt!.buildCommand({ cli: '/fixture/claude', model: 'claude-opus-5', permissionMode: 'ai-review' });
    expect(command.args).toContain('auto');
    expect(command.args).not.toContain('--dangerously-skip-permissions');
    expect(command.autoApproved).not.toBe(true);
    expect(command.args.join(' ')).not.toContain('CLAUDE_CODE_AUTO_MODE_MODEL');
  });
  it.each(['acp', 'tui'] as const)('keeps the native subscription classifier on %s', surface => {
    const result = materializeClaudeSessionBundle({ surface, lifecycle: 'fresh', cwd: '/fixture' }, { mcpServers: [], env: { GUGU_HOME: '/fixture/gugu' }, model: null, autonomy: { permissionMode: 'ai-review' }, promptBlocks: {}, packages: [] });
    expect(result.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBeUndefined();
    expect(result.artifacts).toHaveLength(0);
  });
  it('materializes an explicitly selected reviewer in a protected, path-safe ACP file', () => {
    const reviewer = '../../proxy/reviewer';
    const result = materializeClaudeSessionBundle({ surface: 'acp', lifecycle: 'fresh', cwd: '/fixture' }, {
      mcpServers: [], env: { GUGU_HOME: '/fixture/gugu', CLAUDE_CODE_AUTO_MODE_MODEL: reviewer }, model: null, autonomy: { permissionMode: 'edit' }, promptBlocks: {}, packages: [],
    });
    const artifact = result.artifacts[0]!;
    expect(artifact.path).toMatch(/^\/fixture\/gugu\/capability-packages\/claude\/reviewer-settings\/[a-f0-9]{64}\.json$/);
    expect(artifact.mode).toBe(0o600);
    expect(JSON.parse(artifact.content)).toEqual({ env: { CLAUDE_CODE_AUTO_MODE_MODEL: reviewer } });
    expect(result.acp?.meta).toMatchObject({ claudeCode: { options: { settings: artifact.path } } });
    expect(acpSessionMetaSchema.safeParse(result.acp?.meta).success).toBe(true);
  });
});
