import { describe, expect, it } from 'vitest';
import { resolveModelProvider } from './model-provider';

describe('resolveModelProvider', () => {
  // Claude Code 活目录里 Fable 报的是别名(id 不带 `claude`),只靠 claude/opus/sonnet/haiku 认不出它,
  // 那一行左边于是没有图标(owner 2026-11-11 真机)。
  it.each([
    ['fable', 'Fable 5.2'],
    ['fable[1m]', 'Fable 5.2'],
    ['claude-fable-5-1[1m]', 'Fable 5.1'],
    ['opus[1m]', 'Opus 5.5'],
  ])('%s (%s) is an Anthropic model', (id, name) => {
    expect(resolveModelProvider(id, name)?.id).toBe('anthropic');
  });

  it('does not claim words that merely start with fable', () => {
    expect(resolveModelProvider('fabled-7', 'Fabled 7')).toBeNull();
  });
});
