/** The page as the dialog rules see it: what Chrome reports, who is watching, and how to answer. */
export type DialogPage = {
  on(event: 'javascript-dialog' | 'javascript-dialog-closed' | 'screening' | 'agent-detached' | 'destroyed', listener: (...args: unknown[]) => void): unknown;
  /** Answers the dialog Chrome is showing; resolves quietly when there is none. */
  answerJavaScriptDialog(accept: boolean): Promise<void>;
  /** The person is looking at this page right now. */
  isScreening(): boolean;
  /** An agent holds the page and has Page events on, so it receives the dialog and may answer it. */
  agentListening(): boolean;
};

/** Shows one dialog to the person; resolves true for OK. `null` when there is no window to show it on. */
export type AskPerson = (dialog: { type: 'alert' | 'confirm'; message: string; signal: AbortSignal }) => Promise<boolean> | null;

type Pending = {
  type: 'alert' | 'confirm';
  message: string;
  /** Chrome still waits for an answer; false once anybody answered, so a late reply is never sent. */
  open: boolean;
  /** An agent received it and may answer. */
  agent: boolean;
  showing: AbortController | null;
};

/**
 * The same rules the built-in browser applies to a page's alert / confirm / prompt (browser-page-dialogs.ts), on a page that
 * lives in a headless Chrome, where nothing answers a dialog unless Gugu does and the page stays blocked until then:
 * - the person sees the dialog only on the page they are looking at, over the Gugu window;
 * - a page nobody is looking at: an alert is let through (and shown when the page comes into view), a confirm is cancelled;
 *   unless an agent holds the page, which receives the dialog and decides;
 * - whoever answers first wins; an answer from elsewhere (the agent, or Chrome closing it when the page moves on) closes the one
 *   in front of the person;
 * - prompt is cancelled at once, as in the built-in browser, and the question before leaving a page is left alone.
 */
export function wireStandalonePageDialogs(page: DialogPage, ask: AskPerson): void {
  let pending: Pending | null = null;

  const close = (current: Pending) => {
    current.showing?.abort();
    current.showing = null;
    if (pending === current) pending = null;
  };

  const reply = (current: Pending, accept: boolean) => {
    if (!current.open) return;
    current.open = false;
    void page.answerJavaScriptDialog(accept).catch(() => undefined);
  };

  /** Not in front of the person and nobody else to answer: an alert goes through and waits to be shown, a confirm is cancelled. */
  const answerInBackground = (current: Pending) => {
    reply(current, current.type === 'alert');
    if (current.type !== 'alert') close(current);
  };

  const show = (current: Pending) => {
    if (current.showing) return;
    const controller = new AbortController();
    const answer = ask({ type: current.type, message: current.message, signal: controller.signal });
    if (!answer) return; // No window yet: stays pending until the page is shown again.
    current.showing = controller;
    answer.then(ok => {
      if (controller.signal.aborted) return;
      close(current);
      reply(current, ok);
    }, () => {
      if (controller.signal.aborted) return;
      close(current);
      reply(current, false);
    });
  };

  page.on('javascript-dialog', (...args: unknown[]) => {
    const { type, message } = args[0] as { type: string; message: string }; // What PageTarget emits for Page.javascriptDialogOpening.
    if (type === 'prompt') { void page.answerJavaScriptDialog(false).catch(() => undefined); return; }
    if (type !== 'alert' && type !== 'confirm') return;
    // Chrome shows one dialog at a time, so one still here is an alert kept to be shown or one Chrome has already dropped.
    // It is never answered now: an answer goes to whichever dialog Chrome is showing, which is the new one.
    if (pending) { pending.open = false; close(pending); }
    const current: Pending = { type, message, open: true, agent: page.agentListening(), showing: null };
    pending = current;
    if (page.isScreening()) show(current);
    else if (!current.agent) answerInBackground(current);
  });

  // Somebody else answered, or the page moved on: the dialog in front of the person goes away. Our own answers do not count.
  page.on('javascript-dialog-closed', () => {
    if (!pending) return;
    pending.open = false;
    close(pending);
  });

  // The agent let go without answering: a page nobody is looking at is answered by the background rule.
  page.on('agent-detached', () => {
    if (!pending) return;
    pending.agent = false;
    if (pending.open && !page.isScreening()) answerInBackground(pending);
  });

  page.on('screening', () => {
    if (pending && page.isScreening()) show(pending);
  });

  page.on('destroyed', () => {
    if (pending) close(pending);
  });
}
