import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #50 on API 47's host: an App's 开始转写 with the assistant's page closed wakes this window's voice-note host
 * (`appVoiceNotesActive`, which mounts app-voice-notes-context.tsx at the session app's root) and starts the note once
 * that host has set the assistant — the one getter `voiceNotesAssistantId` saying so, as for `gugu.voiceNote`.
 */
const retry = vi.hoisted(() => vi.fn(async (_id: string) => undefined));
vi.mock('@/lib/assistantPanelBridge', async (importOriginal) => ({ ...(await importOriginal<object>()), assistantPanelAccountId: () => 'owner-1' }));
vi.mock('@renderer/lib/ipc', async (importOriginal) => ({ ...(await importOriginal<object>()), rpc: { app: { saveTextFile: vi.fn() } } }));
vi.mock('@renderer/lib/modal/modal-provider', async (importOriginal) => ({ ...(await importOriginal<object>()), showModal: vi.fn() }));
vi.mock('./voice-note-jobs', async (importOriginal) => ({ ...(await importOriginal<typeof import('./voice-note-jobs')>()), retryVoiceNote: retry }));

const { resourceWindow } = await import('./app-resource-window');
const { appVoiceNotesActive } = await import('./app-voice-notes-active');
const { setVoiceNotesContext, voiceNotesAssistantId } = await import('./voice-note-jobs');
const ask = { ownerId: 'owner-1', assistantId: 'agent-1', noteId: 'n1' };
// What API 47's host sets once mounted (useVoiceNotesContext), first without the home read, then with it.
const contextOf = (machine: unknown) => ({ deviceId: 'home', home: { deviceId: 'home' }, assistantId: 'agent-1', ownerName: null, machine,
  readiness: () => (machine ? 'ready' : 'waiting'), wake: () => undefined, invalidate: () => undefined }) as never;

beforeEach(() => {
  retry.mockReset().mockResolvedValue(undefined);
  setVoiceNotesContext(null);
});

describe('开始转写 with the assistant\'s page closed', () => {
  it('wakes API 47\'s voice-note host and starts the note once it has the assistant', async () => {
    expect(voiceNotesAssistantId()).toBeNull();
    const started = resourceWindow().transcribe(ask);
    expect(appVoiceNotesActive.get()).toBe(true);
    expect(retry).not.toHaveBeenCalled();
    setVoiceNotesContext(contextOf({ home: 'read' }));
    expect(await started).toBe('started');
    expect(retry).toHaveBeenCalledExactlyOnceWith('n1');
  });

  it('the home read after the assistant: tried again when it comes, not refused as not ready', async () => {
    retry.mockImplementation(async () => {
      if (!(retry.mock.calls.length > 1)) throw new Error('machine not ready');
    });
    const started = resourceWindow().transcribe(ask);
    setVoiceNotesContext(contextOf(undefined));
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    setVoiceNotesContext(contextOf({ home: 'read' }));
    expect(await started).toBe('started');
    expect(retry).toHaveBeenCalledTimes(2);
  });
});
