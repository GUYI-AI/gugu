import { describe, expect, it } from 'vitest';
import { claudeModelAllowed, NO_CLAUDE_MODEL_POLICY, type ClaudeModelPolicy } from './claude-model-policy';

const allow = (available: string[], exact = false): ClaudeModelPolicy => ({ available, denied: [], exact });
const deny = (denied: string[]): ClaudeModelPolicy => ({ available: null, denied, exact: false });

// Each row was run on Claude Code 2.1.318 (2026-11-26): CLAUDE_CODE_AUTO_MODE_MODEL=<reviewer> with the policy in a
// managed settings file, read from its debug log ("ignoring CLAUDE_CODE_AUTO_MODE_MODEL … does not allow it" = false).
describe('what Claude Code 2.1.318 lets Auto mode review with', () => {
  it.each<[string, string, ClaudeModelPolicy, boolean]>([
    ['no policy', 'claude-haiku-5-5', NO_CLAUDE_MODEL_POLICY, true],
    ['a family', 'claude-haiku-5-5', allow(['haiku']), true],
    ['a family next to an older version of it', 'claude-haiku-5-5', allow(['haiku', 'claude-haiku-4-5']), false],
    ['a family next to a version of another family', 'claude-haiku-5-5', allow(['haiku', 'claude-sonnet-5']), true],
    ['a version prefix', 'claude-haiku-5-5', allow(['claude-haiku-5']), true],
    ['the full id', 'claude-haiku-5-5', allow(['claude-haiku-5-5']), true],
    ['the family id prefix', 'claude-haiku-5-5', allow(['claude-haiku']), true],
    ['a prefix that cuts a segment', 'claude-haiku-5-5', allow(['claude-hai']), false],
    ['a longer minor version', 'claude-haiku-5-55', allow(['claude-haiku-5-5']), false],
    ['a version prefix, matched exactly', 'claude-haiku-5-5', allow(['claude-haiku-5'], true), false],
    ['a dated id, matched exactly', 'claude-haiku-5-5-20261001', allow(['claude-haiku-5-5'], true), true],
    ['a dated id by prefix', 'claude-haiku-5-5-20261001', allow(['claude-haiku-5-5']), true],
    ['a dated entry for the undated id', 'claude-haiku-5-5', allow(['claude-haiku-5-5-20261001']), false],
    ['an @-dated id', 'claude-haiku-5-5@20261001', allow(['claude-haiku-5-5']), false],
    ['another family', 'claude-haiku-5-5', allow(['sonnet']), false],
    ['an empty list', 'claude-haiku-5-5', allow([]), false],
    ['another case', 'claude-haiku-5-5', allow(['Claude-Haiku-5-5']), true],
    ['a context tag on the name', 'claude-haiku-5-5[1m]', allow(['claude-haiku-5-5']), true],
    ['a provider prefix, by id', 'anthropic/claude-haiku-5-5', allow(['claude-haiku-5-5']), false],
    ['a provider prefix, by family', 'anthropic/claude-haiku-5-5', allow(['haiku']), true],
    ['a provider-spelled older version turns the family off', 'anthropic/claude-haiku-5-5', allow(['haiku', 'anthropic/claude-haiku-4-5']), false],
    ['a Bedrock id, by id', 'us.anthropic.claude-haiku-5-5', allow(['claude-haiku-5-5']), false],
    ['a Bedrock id, by family', 'us.anthropic.claude-haiku-5-5', allow(['haiku']), true],
    ['a gateway alias, by family', 'gugu-review-x', allow(['haiku']), false],
    ['a non-Claude id, by family', 'glm-5', allow(['haiku']), false],
    ['denied: an older version', 'claude-haiku-5-5', deny(['claude-haiku-4-5']), true],
    ['denied: a version prefix', 'claude-haiku-5-5', deny(['claude-haiku-5']), false],
    ['denied: the family', 'claude-haiku-5-5', deny(['haiku']), false],
    ['denied: the full id', 'claude-haiku-5-5', deny(['claude-haiku-5-5']), false],
    ['denied: the full id, provider-spelled name', 'anthropic/claude-haiku-5-5', deny(['claude-haiku-5-5']), false],
  ])('%s', (_case, reviewer, policy, allowed) => {
    expect(claudeModelAllowed(reviewer, policy)).toBe(allowed);
  });

  it('a managed exact match applies to the list in force', () => {
    // Run with `availableModelsMatch: "exact"` managed and `availableModels: ["claude-haiku-5"]` in the user's settings.
    expect(claudeModelAllowed('claude-haiku-5-5', allow(['claude-haiku-5'], true))).toBe(false);
  });

  it('an exact list still lets the -fast id of a listed version through (the CLI settings schema)', () => {
    expect(claudeModelAllowed('claude-opus-5-fast', allow(['claude-opus-5'], true))).toBe(true);
    expect(claudeModelAllowed('claude-opus-5-5-fast', allow(['claude-opus-5'], true))).toBe(false);
  });

  it('a denial wins over a list that names the model', () => {
    expect(claudeModelAllowed('claude-haiku-5-5', { available: ['claude-haiku-5-5'], denied: ['claude-haiku-5-5'], exact: false })).toBe(false);
  });
});
