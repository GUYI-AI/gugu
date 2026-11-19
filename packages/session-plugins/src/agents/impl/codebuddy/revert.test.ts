import { describe, expect, it, vi } from 'vitest';
import { codebuddyRevert } from './revert';

describe('codebuddy revert hook', () => {
  it('takes the point from the prompt response and always says why it rolls back', async () => {
    expect(await codebuddyRevert.point({} as never, 's', { stopReason: 'end_turn', userMessageId: 'u-1' })).toEqual({ before: 'u-1' });
    expect(await codebuddyRevert.point({} as never, 's', { stopReason: 'end_turn' })).toBeNull();
    const extMethod = vi.fn(async () => ({ applied: true }));
    await codebuddyRevert.revert({ extMethod } as never, 's', 'u-1', false);
    expect(extMethod).toHaveBeenCalledWith('_codebuddy.ai/session/rollback', { sessionId: 's', targetMessageId: 'u-1', reason: 'resend_edit' });
  });

  it('an unapplied rollback is a failure, and a file restore is never attempted', async () => {
    await expect(codebuddyRevert.revert({ extMethod: vi.fn(async () => ({ applied: false, error: 'Cannot resolve fork point' })) } as never,
      's', 'x', false)).rejects.toThrow('Cannot resolve fork point');
    const extMethod = vi.fn();
    await expect(codebuddyRevert.revert({ extMethod } as never, 's', 'u-1', true)).rejects.toThrow('conversation only');
    expect(extMethod).not.toHaveBeenCalled();
  });
});
