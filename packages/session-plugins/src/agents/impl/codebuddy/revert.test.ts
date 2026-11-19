import { describe, expect, it, vi } from 'vitest';
import { codebuddyRevert } from './revert';

describe('codebuddy rewind hook (#2970)', () => {
  it('takes the point from the prompt response and always says why it rolls back', async () => {
    expect(await codebuddyRevert.anchorAfterTurn({} as never, 's', { stopReason: 'end_turn', userMessageId: 'u-1' })).toEqual({ before: 'u-1', files: false });
    expect(await codebuddyRevert.anchorAfterTurn({} as never, 's', { stopReason: 'end_turn' })).toBeNull();
    const extMethod = vi.fn(async () => ({ applied: true }));
    await codebuddyRevert.revert({ extMethod } as never, { sessionId: 's', before: 'u-1', files: 'keep' });
    expect(extMethod).toHaveBeenCalledWith('_codebuddy.ai/session/rollback', { sessionId: 's', targetMessageId: 'u-1', reason: 'resend_edit' });
  });

  it('an unapplied rollback is a failure, and a file restore is never attempted', async () => {
    await expect(codebuddyRevert.revert({ extMethod: vi.fn(async () => ({ applied: false, error: 'Cannot resolve fork point' })) } as never,
      { sessionId: 's', before: 'x', files: 'keep' })).rejects.toThrow('Cannot resolve fork point');
    const extMethod = vi.fn();
    await expect(codebuddyRevert.revert({ extMethod } as never, { sessionId: 's', before: 'u-1', files: 'restore' })).rejects.toThrow('conversation only');
    expect(extMethod).not.toHaveBeenCalled();
  });
});
