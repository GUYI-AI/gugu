import { describe, expect, it } from 'vitest';
import { liveWindowActivity, recordLiveWindowActivity } from './live-window-activity';
import { observeLiveWindowSources } from './live-window-source-changes';

describe('host-owned live window activity', () => {
  it('orders the admitted source Apps independently for each session', () => {
    const session = 'activity-task';
    let changes = 0;
    const stop = observeLiveWindowSources(session, () => { changes++; });
    recordLiveWindowActivity(session, 'browser-use');
    const browser = liveWindowActivity(session, 'browser-use')!;
    recordLiveWindowActivity(session, 'computer-use');
    expect(liveWindowActivity(session, 'computer-use')).toBeGreaterThan(browser);
    expect(liveWindowActivity('different-task', 'computer-use')).toBeUndefined();
    recordLiveWindowActivity(session, 'workspace');
    expect(changes).toBe(2);
    expect(liveWindowActivity(session, 'workspace')).toBeUndefined();
    // Reading metadata/watching has no producer authority to advance activity.
    expect(liveWindowActivity(session, 'browser-use')).toBe(browser);
    stop();
  });
});
