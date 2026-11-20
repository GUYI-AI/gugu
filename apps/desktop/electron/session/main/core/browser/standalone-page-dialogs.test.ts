import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireStandalonePageDialogs, type AskPerson } from './standalone-page-dialogs';

/** A page Chrome keeps blocked until the dialog is answered; the person and the agent answer from outside. */
function fixture(options: { screening?: boolean; agent?: boolean } = {}) {
  const page = Object.assign(new EventEmitter(), {
    screening: options.screening ?? true,
    agent: options.agent ?? false,
    answers: [] as boolean[],
    answerJavaScriptDialog: vi.fn(async (accept: boolean) => { page.answers.push(accept); }),
    isScreening: () => page.screening,
    agentListening: () => page.agent,
  });
  const shown: { type: string; message: string; signal: AbortSignal; choose(ok: boolean): void }[] = [];
  const ask = vi.fn<AskPerson>(({ type, message, signal }) => new Promise<boolean>(resolve => {
    shown.push({ type, message, signal, choose: resolve });
  }));
  wireStandalonePageDialogs(page, ask);
  const open = (type: string, message = 'sure?') => page.emit('javascript-dialog', { type, message });
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  return { page, ask, shown, open, settle };
}

describe('standalone page dialogs', () => {
  it('shows an alert to the person on the page they are looking at and lets the page go on when they press OK', async () => {
    const f = fixture();
    f.open('alert', 'saved');
    expect(f.shown).toHaveLength(1);
    expect(f.shown[0]).toMatchObject({ type: 'alert', message: 'saved' });
    expect(f.page.answers).toEqual([]);
    f.shown[0]!.choose(true);
    await f.settle();
    expect(f.page.answers).toEqual([true]);
  });

  it('answers a confirm with what the person pressed', async () => {
    const f = fixture();
    f.open('confirm', 'delete?');
    f.shown[0]!.choose(false);
    await f.settle();
    f.open('confirm', 'again?');
    f.shown[1]!.choose(true);
    await f.settle();
    expect(f.page.answers).toEqual([false, true]);
  });

  it('cancels a prompt at once, as the built-in browser does, and shows nothing', async () => {
    const f = fixture();
    f.open('prompt', 'name?');
    await f.settle();
    expect(f.shown).toHaveLength(0);
    expect(f.page.answers).toEqual([false]);
  });

  it('shows nothing for a page nobody is looking at: an alert is let through, a confirm is cancelled', async () => {
    const f = fixture({ screening: false });
    f.open('alert', 'hidden alert');
    f.open('confirm', 'hidden confirm');
    await f.settle();
    expect(f.shown).toHaveLength(0);
    expect(f.page.answers).toEqual([true, false]);
  });

  it('shows a let-through alert when the page comes into view, without answering it again', async () => {
    const f = fixture({ screening: false });
    f.open('alert', 'hidden alert');
    await f.settle();
    f.page.screening = true;
    f.page.emit('screening');
    expect(f.shown).toHaveLength(1);
    expect(f.shown[0]!.message).toBe('hidden alert');
    f.shown[0]!.choose(true);
    await f.settle();
    expect(f.page.answers).toEqual([true]); // Only the answer given while it was hidden.
  });

  it('leaves a hidden page waiting for the agent that holds it, and shows the dialog when the person arrives', async () => {
    const f = fixture({ screening: false, agent: true });
    f.open('confirm', 'agent decides');
    await f.settle();
    expect(f.page.answers).toEqual([]);
    expect(f.shown).toHaveLength(0);
    f.page.screening = true;
    f.page.emit('screening');
    expect(f.shown).toHaveLength(1);
    f.shown[0]!.choose(true);
    await f.settle();
    expect(f.page.answers).toEqual([true]);
  });

  it('closes the dialog in front of the person when the agent answered it first, and does not answer again', async () => {
    const f = fixture({ agent: true });
    f.open('confirm', 'both can see');
    const [shown] = f.shown;
    expect(shown!.signal.aborted).toBe(false);
    f.page.emit('javascript-dialog-closed'); // Chrome: somebody else answered.
    expect(shown!.signal.aborted).toBe(true);
    shown!.choose(true); // A late click on the closed box means nothing.
    await f.settle();
    expect(f.page.answers).toEqual([]);
  });

  it('answers a hidden page itself once the agent that was holding it lets go', async () => {
    const f = fixture({ screening: false, agent: true });
    f.open('confirm', 'agent left');
    await f.settle();
    f.page.agent = false;
    f.page.emit('agent-detached');
    await f.settle();
    expect(f.page.answers).toEqual([false]);
  });

  it('closes the dialog when the page moves on or is closed while it is showing', async () => {
    const f = fixture();
    f.open('confirm', 'leaving');
    f.page.emit('javascript-dialog-closed');
    expect(f.shown[0]!.signal.aborted).toBe(true);
    f.open('alert', 'next page');
    f.page.emit('destroyed');
    expect(f.shown[1]!.signal.aborted).toBe(true);
    await f.settle();
    expect(f.page.answers).toEqual([]);
  });

  it('replaces a dialog nobody answered with the new one', async () => {
    const f = fixture({ agent: true });
    f.open('confirm', 'first');
    f.open('confirm', 'second');
    expect(f.shown[0]!.signal.aborted).toBe(true);
    f.shown[1]!.choose(true);
    await f.settle();
    expect(f.page.answers).toEqual([true]);
  });

  it('leaves a page-unload question alone', async () => {
    const f = fixture();
    f.open('beforeunload', 'leave site?');
    await f.settle();
    expect(f.shown).toHaveLength(0);
    expect(f.page.answers).toEqual([]);
  });

  it('keeps the dialog pending while there is no window to show it on', async () => {
    const f = fixture();
    f.ask.mockImplementationOnce(() => null);
    f.open('confirm', 'no window');
    await f.settle();
    expect(f.page.answers).toEqual([]);
    f.page.emit('screening'); // A window exists now.
    expect(f.shown).toHaveLength(1);
  });
});
