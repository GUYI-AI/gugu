// GUYI-AI/gugu#2548 C9: the sidebar's two-step intro (侧栏可以收起来 → 会话历史): when it comes up, how it moves, what
// ends it for good, and which step is drawn.
import { describe, expect, it } from 'vitest';
import { nextSidebarIntro, sidebarIntroShown, type SidebarIntro, type SidebarIntroEvent } from './sidebar-intro';

const run = (events: SidebarIntroEvent[], from: SidebarIntro = { step: 'collapse', up: false }) => events.reduce(nextSidebarIntro, from);
const opened = { kind: 'opened', expanded: true } as const;
const view = { expanded: true, onScreen: true, notificationsOpen: false, touring: false };

describe('it comes up', () => {
  it('the first time a group or a project is opened while the sidebar is expanded, at step 1', () => {
    expect(run([opened])).toEqual({ step: 'collapse', up: true });
  });

  it('not when it is opened with the sidebar collapsed', () => {
    expect(run([{ kind: 'opened', expanded: false }])).toEqual({ step: 'collapse', up: false });
  });

  it('at the stored step: an intro left on step 2 comes up on step 2', () => {
    expect(run([opened], { step: 'history', up: false })).toEqual({ step: 'history', up: true });
  });

  it('and stays where it is while other groups are opened', () => {
    expect(run([opened, { kind: 'next' }, opened])).toEqual({ step: 'history', up: true });
  });
});

describe('the steps', () => {
  it('下一步 goes to 会话历史 and 上一步 back', () => {
    expect(run([opened, { kind: 'next' }])).toEqual({ step: 'history', up: true });
    expect(run([opened, { kind: 'next' }, { kind: 'previous' }])).toEqual({ step: 'collapse', up: true });
  });

  it('collapsing while step 1 shows is step 1 learned: on to step 2, still up', () => {
    expect(run([opened, { kind: 'collapsed' }])).toEqual({ step: 'history', up: true });
  });

  it('collapsing before it ever came up: it will come up at step 2', () => {
    expect(run([{ kind: 'collapsed' }])).toEqual({ step: 'history', up: false });
    expect(run([{ kind: 'collapsed' }, opened])).toEqual({ step: 'history', up: true });
  });

  it('collapsing on step 2 changes nothing', () => {
    expect(run([opened, { kind: 'next' }, { kind: 'collapsed' }])).toEqual({ step: 'history', up: true });
  });
});

describe('it ends for good', () => {
  it('on 跳过 (step 1), 完成 / 打开看看 (step 2) and Escape (either)', () => {
    expect(run([opened, { kind: 'end' }]).step).toBe('ended');
    expect(run([opened, { kind: 'next' }, { kind: 'end' }]).step).toBe('ended');
  });

  it('and nothing brings it back', () => {
    const ended = run([opened, { kind: 'end' }]);
    for (const event of [opened, { kind: 'collapsed' }, { kind: 'next' }, { kind: 'previous' }] as SidebarIntroEvent[]) {
      expect(nextSidebarIntro(ended, event)).toBe(ended);
    }
  });
});

describe('the step drawn', () => {
  it('is the stored step while up, on screen and not behind the bell\'s panel', () => {
    expect(sidebarIntroShown('collapse', true, view)).toBe('collapse');
    expect(sidebarIntroShown('history', true, view)).toBe('history');
    expect(sidebarIntroShown('collapse', false, view)).toBeNull();
    expect(sidebarIntroShown('ended', true, view)).toBeNull();
    expect(sidebarIntroShown('history', true, { ...view, onScreen: false })).toBeNull();
    expect(sidebarIntroShown('history', true, { ...view, notificationsOpen: true })).toBeNull();
  });

  it('steps aside while the feature tour is on screen, without ending: two bubbles never show at once', () => {
    expect(sidebarIntroShown('collapse', true, { ...view, touring: true })).toBeNull();
    expect(sidebarIntroShown('history', true, { ...view, touring: true })).toBeNull();
    expect(sidebarIntroShown('history', true, { ...view, touring: false })).toBe('history');
  });

  it('neither step on the rail (会话历史 hides there with the names), and neither is ended by it', () => {
    expect(sidebarIntroShown('history', true, { ...view, expanded: false })).toBeNull();
    expect(sidebarIntroShown('collapse', true, { ...view, expanded: false })).toBeNull();
    // Expanded again, the step it waited on is drawn.
    expect(sidebarIntroShown('history', true, view)).toBe('history');
  });

  it('nothing before the settings are read (no flash of an intro already ended)', () => {
    expect(sidebarIntroShown(undefined, true, view)).toBeNull();
  });
});
