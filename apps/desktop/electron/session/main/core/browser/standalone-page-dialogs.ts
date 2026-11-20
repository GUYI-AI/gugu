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

export function wireStandalonePageDialogs(_page: DialogPage, _ask: AskPerson): void {
  // Not implemented yet.
}
