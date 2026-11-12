// GUYI-AI/gugu#2548 C9: when the one-time 「侧栏可以收起来」 bubble shows, and what retires it for good.
import { describe, expect, it } from 'vitest';
import {
  nextSidebarCollapseHint,
  sidebarCollapseHintShown,
  sidebarCollapseHintState,
  type SidebarCollapseHint,
  type SidebarCollapseHintEvent,
} from './sidebar-collapse-hint';

const run = (events: SidebarCollapseHintEvent[], from: SidebarCollapseHint = 'waiting') =>
  events.reduce(nextSidebarCollapseHint, from);
const view = { expanded: true, onScreen: true, notificationsOpen: false };

describe('it comes up', () => {
  it('the first time a group or a project is opened while the sidebar is expanded', () => {
    expect(run([{ kind: 'opened', expanded: true }])).toBe('showing');
  });

  it('not when it is opened with the sidebar collapsed', () => {
    expect(run([{ kind: 'opened', expanded: false }])).toBe('waiting');
  });

  it('and stays up while other groups are opened, until it is answered', () => {
    expect(run([{ kind: 'opened', expanded: true }, { kind: 'opened', expanded: true }])).toBe('showing');
  });
});

describe('it retires for good', () => {
  it('on either of its buttons (知道了 / 收起试试)', () => {
    expect(run([{ kind: 'opened', expanded: true }, { kind: 'answered' }])).toBe('retired');
  });

  it('once the sidebar is collapsed by any route, even before it ever came up', () => {
    expect(run([{ kind: 'opened', expanded: true }, { kind: 'collapsed' }])).toBe('retired');
    expect(run([{ kind: 'collapsed' }])).toBe('retired');
  });

  it('and nothing brings it back', () => {
    expect(run([{ kind: 'answered' }, { kind: 'opened', expanded: true }])).toBe('retired');
    expect(run([{ kind: 'collapsed' }, { kind: 'opened', expanded: true }])).toBe('retired');
  });

  it('the stored answer wins over this run; not read yet counts as answered (no flash)', () => {
    expect(sidebarCollapseHintState(true, 'showing')).toBe('retired');
    expect(sidebarCollapseHintState(undefined, 'showing')).toBe('retired');
    expect(sidebarCollapseHintState(false, 'showing')).toBe('showing');
    expect(sidebarCollapseHintState(false, 'waiting')).toBe('waiting');
  });
});

describe('it is drawn', () => {
  it('only while up, expanded, on screen and not behind the bell\'s panel', () => {
    expect(sidebarCollapseHintShown('showing', view)).toBe(true);
    expect(sidebarCollapseHintShown('waiting', view)).toBe(false);
    expect(sidebarCollapseHintShown('retired', view)).toBe(false);
    expect(sidebarCollapseHintShown('showing', { ...view, expanded: false })).toBe(false);
    expect(sidebarCollapseHintShown('showing', { ...view, onScreen: false })).toBe(false);
    expect(sidebarCollapseHintShown('showing', { ...view, notificationsOpen: true })).toBe(false);
  });
});
