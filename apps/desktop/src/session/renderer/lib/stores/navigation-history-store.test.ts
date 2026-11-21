import { describe, expect, it } from 'vitest';
import { NavigationHistoryStore, type HistoryEntry } from './navigation-history-store';

const apps = (place: string): HistoryEntry => ({ kind: 'view', viewId: 'apps', params: {}, place });

describe('NavigationHistoryStore places', () => {
  it('two places of one view are two steps; the same place again is none', () => {
    const history = new NavigationHistoryStore();
    history.push(apps('list'));
    history.push(apps('page'));
    history.push(apps('page'));
    expect(history.entries.map((entry) => entry.kind === 'view' && entry.place)).toEqual(['list', 'page']);
  });

  it('replaceCurrent rewrites the step you are on, only for the same view and never while going back', () => {
    const history = new NavigationHistoryStore();
    history.push(apps('list'));
    history.push(apps('page'));
    history.replaceCurrent({ kind: 'view', viewId: 'home', params: {} });
    history.replaceCurrent(apps('other page'));
    expect(history.entries.map((entry) => entry.kind === 'view' && entry.place)).toEqual(['list', 'other page']);

    history.back(() => history.replaceCurrent(apps('moved while replaying')));
    expect(history.entries.map((entry) => entry.kind === 'view' && entry.place)).toEqual(['list', 'other page']);
    expect(history.index).toBe(0);
  });

  it('start records where a launch landed only while nothing is recorded, so the first step can go back to it', () => {
    const history = new NavigationHistoryStore();
    history.start(apps('landed'));
    history.push(apps('page'));
    history.start(apps('ignored'));
    expect(history.entries.map((entry) => entry.kind === 'view' && entry.place)).toEqual(['landed', 'page']);
    expect(history.canGoBack).toBe(true);
  });
});
