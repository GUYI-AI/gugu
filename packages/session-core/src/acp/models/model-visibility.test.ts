import { expect, it } from 'vitest';
import { isUserFacingModelId } from './model-visibility';
it('reserves only the internal review model, retaining normal model IDs', () => {
  expect(isUserFacingModelId('codex-auto-review')).toBe(false);
  expect(isUserFacingModelId(' CODEX-AUTO-REVIEW ')).toBe(false);
  expect(isUserFacingModelId('gpt-6.1-sol')).toBe(true);
  expect(isUserFacingModelId('claude-haiku-5-5')).toBe(true);
});
