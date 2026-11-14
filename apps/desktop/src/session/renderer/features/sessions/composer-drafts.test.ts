// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerDrafts } from './composer-drafts';
import type { ComposerAttachmentDraft } from './composer-attachment-draft';

describe('creation draft handoff', () => {
  it('moves the edited first turn back without a stale copy replacing it', () => {
    composerDrafts.set('handoff-home', '最初的首句');
    composerDrafts.moveToEmpty('handoff-home', 'handoff-project');
    expect(composerDrafts.get('handoff-home')).toBe('');
    composerDrafts.set('handoff-project', '在项目里改过的首句');
    composerDrafts.moveToEmpty('handoff-project', 'handoff-home');
    expect(composerDrafts.get('handoff-home')).toBe('在项目里改过的首句');
    expect(composerDrafts.get('handoff-project')).toBe('');
  });

  it('moves attachment-only drafts with their original bytes, then consumes the handoff', () => {
    const snapshot: ComposerAttachmentDraft = {
      pending: [{ chip: { id: 'attachment', name: 'note.txt', kind: 'file' }, file: new File(['abc'], 'note.txt') }],
    };
    const draft = composerDrafts.forKey('attachment-home');
    draft.setPending(snapshot.pending);
    composerDrafts.moveToEmpty('attachment-home', 'attachment-project');
    expect(composerDrafts.forKey('attachment-project')).toBe(draft);
    expect(draft.pending).toBe(snapshot.pending);
    composerDrafts.forKey('attachment-project').take();
    expect(draft.pending).toEqual([]);
  });

  it('keeps both drafts when the destination already has unsent text', () => {
    composerDrafts.set('occupied-home', '全局首句');
    composerDrafts.set('occupied-project', '项目已有首句');
    composerDrafts.moveToEmpty('occupied-home', 'occupied-project');
    expect(composerDrafts.get('occupied-home')).toBe('全局首句');
    expect(composerDrafts.get('occupied-project')).toBe('项目已有首句');
  });
});

describe('a half-written first turn across a restart', () => {
  const signIn = (accountId: string | null) => {
    (window as unknown as Record<string, unknown>).__GUGU_NATIVE_INPUT_OUTBOX__ = { accountId, queue: null, rows: [], listeners: new Set(), valid: () => accountId !== null };
  };
  // A restart = a fresh renderer: the in-memory drafts are gone, only what was stored remains.
  const restart = async () => { vi.resetModules(); return (await import('./composer-drafts')).composerDrafts; };
  afterEach(() => { signIn(null); localStorage.clear(); });

  it('restores the words of a new-task box (sample project, project page) for the same account, and forgets them once sent', async () => {
    signIn('owner');
    composerDrafts.set('project:restart', 'restart draft task');
    let after = await restart();
    expect(after.get('project:restart'), 'in memory only = a restart loses it').toBe('');
    expect(after.forKey('project:restart').prompt).toBe('restart draft task');
    signIn('someone-else');
    after = await restart();
    expect(after.forKey('project:restart').prompt, 'another account does not see it').toBe('');
    signIn('owner');
    after = await restart();
    after.forKey('project:restart').take();
    after = await restart();
    expect(after.forKey('project:restart').prompt).toBe('');
  });

  it('a draft moved to another target is stored under that target', async () => {
    signIn('owner');
    composerDrafts.set('moving-home', 'carried words');
    composerDrafts.moveToEmpty('moving-home', 'project:moved');
    const after = await restart();
    expect(after.forKey('moving-home').prompt).toBe('');
    expect(after.forKey('project:moved').prompt).toBe('carried words');
  });

  it('read once the account is ready, not before', async () => {
    signIn('owner');
    composerDrafts.set('project:late', 'kept words');
    signIn(null);
    const after = await restart();
    expect(after.forKey('project:late').prompt).toBe('');
    signIn('owner');
    expect(after.forKey('project:late').prompt).toBe('kept words');
  });
});
