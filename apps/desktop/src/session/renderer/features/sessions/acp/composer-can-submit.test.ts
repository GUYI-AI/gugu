import { describe, expect, it } from 'vitest';
import { composerCanSubmit } from './composer-can-submit';

const base = { promptReady: false, isWorking: false, reverting: false, editingMessage: false, queuesOffline: false, hasDraft: true, attachmentWaiting: false, membershipLocked: false };

describe('composerCanSubmit (#2348)', () => {
  it('keeps Send live while the agent works, so a typed message can be queued by clicking as well as by Enter', () => {
    expect(composerCanSubmit({ ...base, isWorking: true })).toBe(true);
  });
  it('is live when the prompt is ready, or when input queues for a machine that is not connected', () => {
    expect(composerCanSubmit({ ...base, promptReady: true })).toBe(true);
    expect(composerCanSubmit({ ...base, queuesOffline: true })).toBe(true);
  });
  it('holds Send for an empty draft, a waiting attachment or a membership-locked model, working or not', () => {
    for (const isWorking of [true, false]) {
      expect(composerCanSubmit({ ...base, promptReady: true, isWorking, hasDraft: false })).toBe(false);
      expect(composerCanSubmit({ ...base, promptReady: true, isWorking, attachmentWaiting: true })).toBe(false);
      expect(composerCanSubmit({ ...base, promptReady: true, isWorking, membershipLocked: true })).toBe(false);
    }
  });
  it('does not open Send for a working agent during a revert or a message edit', () => {
    expect(composerCanSubmit({ ...base, isWorking: true, reverting: true })).toBe(false);
    expect(composerCanSubmit({ ...base, isWorking: true, editingMessage: true })).toBe(false);
  });
  it('stays closed when nothing can take the input', () => {
    expect(composerCanSubmit(base)).toBe(false);
  });
});
