import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_WAIT_MS, createResourceWindow, type ResourceWindowDeps } from './app-resource-window-core';

/**
 * #48 The window's half of an App's managing calls: the assistant page's own question before a delete (its words), its
 * 开始转写 (`retryVoiceNote`) and its 导出 Markdown (its file name, its Markdown, the save dialog) — each only for the
 * account (and assistant) this window has itself.
 */
const OWNER = 'owner-1';
const AGENT = 'agent-1';
let deps: ResourceWindowDeps & { [K in 'retry' | 'forget' | 'confirm' | 'saveTextFile' | 'wait']: ReturnType<typeof vi.fn> };
let account: string | null;
let context: string | null;
let phase: string | null;

beforeEach(() => {
  account = OWNER; context = AGENT; phase = null;
  deps = {
    account: () => account,
    contextAssistant: () => context,
    jobPhase: () => phase,
    retry: vi.fn(async () => undefined),
    forget: vi.fn(),
    confirm: vi.fn(async () => true),
    t: (key, ns, values) => `${ns}:${key}${values ? JSON.stringify(values) : ''}`,
    saveTextFile: vi.fn(async () => ({ success: true, path: '/chosen/Standup.md' })),
    wait: vi.fn(async () => undefined),
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

describe('开始转写', () => {
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

  it('waits for the voice-note host to come up for this assistant, then says not ready; a pipeline that throws is not ready', async () => {
    const window = createResourceWindow(deps);
    context = null;
    expect(await window.transcribe(ask)).toBe('not-ready');
    expect(deps.wait).toHaveBeenCalledTimes(CONTEXT_WAIT_MS / 250);
    expect(deps.retry).not.toHaveBeenCalled();
    deps.wait.mockReset().mockImplementationOnce(async () => { context = AGENT; });
    expect(await window.transcribe(ask)).toBe('started');
    deps.retry.mockRejectedValueOnce(new Error('no voice-note host'));
    expect(await window.transcribe(ask)).toBe('not-ready');
  });

  it('another account, here or while waiting, is denied', async () => {
    const window = createResourceWindow(deps);
    account = 'someone-else';
    expect(await window.transcribe(ask)).toBe('denied');
    account = OWNER; context = null;
    deps.wait.mockImplementationOnce(async () => { account = 'someone-else'; });
    expect(await window.transcribe(ask)).toBe('denied');
    expect(deps.retry).not.toHaveBeenCalled();
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
