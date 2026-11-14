import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TRANSCRIBE_WAIT_MS, createResourceWindow, type ResourceWindowDeps } from './app-resource-window-core';

/**
 * #50 The window's half of an App's managing calls: the assistant page's own question before a delete (its words), its
 * 开始转写 (`retryVoiceNote`) and its 导出 Markdown (its file name, its Markdown, the save dialog) — each only for the
 * account (and assistant) this window has itself.
 */
const OWNER = 'owner-1';
const AGENT = 'agent-1';
type Spied = 'retry' | 'forget' | 'confirm' | 'saveTextFile' | 'activate' | 'contextChanged';
let deps: Omit<ResourceWindowDeps, Spied> & { [K in Spied]: Mock<ResourceWindowDeps[K]> };
let account: string | null;
let context: string | null;
let phase: string | null;
let clock: number;

beforeEach(() => {
  account = OWNER; context = AGENT; phase = null; clock = 0;
  deps = {
    account: () => account,
    contextAssistant: () => context,
    jobPhase: () => phase,
    retry: vi.fn<ResourceWindowDeps['retry']>(async () => undefined),
    forget: vi.fn<ResourceWindowDeps['forget']>(),
    confirm: vi.fn<ResourceWindowDeps['confirm']>(async () => true),
    t: (key, ns, values) => `${ns}:${key}${values ? JSON.stringify(values) : ''}`,
    saveTextFile: vi.fn<ResourceWindowDeps['saveTextFile']>(async () => ({ success: true, path: '/chosen/Standup.md' })),
    activate: vi.fn<ResourceWindowDeps['activate']>(),
    contextChanged: vi.fn<ResourceWindowDeps['contextChanged']>(async () => false),
    now: () => clock,
  };
});

describe('the question before a delete', () => {
  it('a folder: the files page\'s words; the answer is the person\'s', async () => {
    const window = createResourceWindow(deps);
    expect(await window.confirmRemoval({ kind: 'folder', name: 'docs' })).toBe(true);
    expect(deps.confirm).toHaveBeenCalledExactlyOnceWith({ title: 'assistant:files.deleteFolderTitle', description: 'assistant:files.deleteFolderBody{"name":"docs"}', confirmLabel: 'assistant:common.delete' });
    deps.confirm.mockResolvedValueOnce(false);
    expect(await window.confirmRemoval({ kind: 'folder', name: 'docs' })).toBe(false);
  });

  it('a voice note: the voice notes page\'s words, untitled when it has no title; yes stops this window\'s own job for it', async () => {
    const window = createResourceWindow(deps);
    expect(await window.confirmRemoval({ kind: 'voice-note', title: null, ownerId: OWNER, assistantId: AGENT, noteId: 'n1' })).toBe(true);
    expect(deps.confirm).toHaveBeenCalledExactlyOnceWith({ title: 'voiceNotes:deleteTitle{"name":"voiceNotes:untitled"}', description: 'voiceNotes:deleteBody', confirmLabel: 'voiceNotes:delete' });
    expect(deps.forget).toHaveBeenCalledExactlyOnceWith('n1');
    // Another assistant's here: its jobs are not this note's.
    context = 'agent-2';
    expect(await window.confirmRemoval({ kind: 'voice-note', title: 'Standup', ownerId: OWNER, assistantId: AGENT, noteId: 'n1' })).toBe(true);
    expect(deps.forget).toHaveBeenCalledTimes(1);
    deps.confirm.mockResolvedValueOnce(false);
    context = AGENT;
    expect(await window.confirmRemoval({ kind: 'voice-note', title: 'Standup', ownerId: OWNER, assistantId: AGENT, noteId: 'n1' })).toBe(false);
    expect(deps.forget).toHaveBeenCalledTimes(1);
  });

  it('a window signed in to another account asks nothing, or says no when it changed while asking', async () => {
    const window = createResourceWindow(deps);
    account = 'someone-else';
    expect(await window.confirmRemoval({ kind: 'voice-note', title: 'Standup', ownerId: OWNER, assistantId: AGENT, noteId: 'n1' })).toBe(false);
    expect(deps.confirm).not.toHaveBeenCalled();
    account = OWNER;
    deps.confirm.mockImplementationOnce(async () => { account = 'someone-else'; return true; });
    expect(await window.confirmRemoval({ kind: 'voice-note', title: 'Standup', ownerId: OWNER, assistantId: AGENT, noteId: 'n1' })).toBe(false);
    expect(deps.forget).not.toHaveBeenCalled();
  });
});

describe('开始转写, with the assistant\'s page open or not', () => {
  const ask = { ownerId: OWNER, assistantId: AGENT, noteId: 'n1' };
  it('this window\'s pipeline for the note: started; one already working is busy', async () => {
    const window = createResourceWindow(deps);
    expect(await window.transcribe(ask)).toBe('started');
    expect(deps.retry).toHaveBeenCalledExactlyOnceWith('n1');
    for (const working of ['recording', 'uploading', 'transcribing', 'summarizing']) {
      phase = working;
      expect(await window.transcribe(ask)).toBe('busy');
    }
    phase = 'failed';
    expect(await window.transcribe(ask)).toBe('started');
    expect(deps.retry).toHaveBeenCalledTimes(2);
  });

  it('the page closed (no context here): API 47\'s host is woken and the note started once it has the assistant', async () => {
    const window = createResourceWindow(deps);
    context = null;
    deps.contextChanged.mockImplementationOnce(async () => { context = AGENT; return true; });
    expect(await window.transcribe(ask)).toBe('started');
    expect(deps.activate).toHaveBeenCalledTimes(1);
    expect(deps.retry).toHaveBeenCalledExactlyOnceWith('n1');
  });

  it('its home not read yet: tried again on the next change of the context, not refused for it', async () => {
    const window = createResourceWindow(deps);
    deps.retry.mockRejectedValueOnce(new Error('machine not ready'));
    deps.contextChanged.mockResolvedValueOnce(true);
    expect(await window.transcribe(ask)).toBe('started');
    expect(deps.retry).toHaveBeenCalledTimes(2);
    expect(deps.contextChanged).toHaveBeenCalledTimes(1);
  });

  it('another assistant\'s context here, or none coming before the deadline: not ready, nothing started', async () => {
    const window = createResourceWindow(deps);
    context = 'agent-2';
    deps.contextChanged.mockResolvedValue(false);
    expect(await window.transcribe(ask)).toBe('not-ready');
    expect(deps.contextChanged).toHaveBeenCalledExactlyOnceWith(TRANSCRIBE_WAIT_MS);
    context = AGENT;
    deps.retry.mockRejectedValue(new Error('machine not ready'));
    expect(await window.transcribe(ask)).toBe('not-ready');
    // Changes keep coming, the home never read: the deadline still holds.
    deps.contextChanged.mockImplementation(async (ms) => { clock += Math.min(ms, 6_000); return true; });
    expect(await window.transcribe(ask)).toBe('not-ready');
  });

  it('another account, here or while waiting, is denied', async () => {
    const window = createResourceWindow(deps);
    account = 'someone-else';
    expect(await window.transcribe(ask)).toBe('denied');
    expect(deps.activate).not.toHaveBeenCalled();
    account = OWNER; context = null;
    deps.contextChanged.mockImplementationOnce(async () => { account = 'someone-else'; context = AGENT; return true; });
    expect(await window.transcribe(ask)).toBe('denied');
    expect(deps.retry).not.toHaveBeenCalled();
  });
});

describe('delete and export need no voice-note context: the page closed, they work', () => {
  it('asks and answers with no assistant set up in this window', async () => {
    context = null;
    const window = createResourceWindow(deps);
    expect(await window.confirmRemoval({ kind: 'voice-note', title: 'Standup', ownerId: OWNER, assistantId: AGENT, noteId: 'n1' })).toBe(true);
    expect(await window.exportNote({ ownerId: OWNER, title: 'Standup', summary: 'Ship it', transcript: null })).toBe('saved');
    expect(deps.forget).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });
});

describe('导出 Markdown', () => {
  it('the page\'s file name and Markdown through the save dialog: saved, cancelled, failed', async () => {
    const window = createResourceWindow(deps);
    const ask = { ownerId: OWNER, title: 'Standup', summary: '# Standup\nShip it', transcript: '[00:00] Me: ship it' };
    expect(await window.exportNote(ask)).toBe('saved');
    const saved = deps.saveTextFile.mock.calls[0]![0] as { title: string; defaultPath: string; content: string };
    expect(saved.title).toBe('voiceNotes:exportTitle');
    expect(saved.defaultPath).toMatch(/Standup.*\.md$/);
    expect(saved.content).toContain('Ship it');
    deps.saveTextFile.mockResolvedValueOnce({ success: true });
    expect(await window.exportNote(ask)).toBe('cancelled');
    deps.saveTextFile.mockResolvedValueOnce({ success: false });
    expect(await window.exportNote(ask)).toBe('failed');
    account = 'someone-else';
    expect(await window.exportNote(ask)).toBe('denied');
    expect(deps.saveTextFile).toHaveBeenCalledTimes(3);
  });
});
