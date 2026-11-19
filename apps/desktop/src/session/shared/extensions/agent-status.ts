/**
 * #6387 What gugu knows about an extension's agent programs (gugu runs them, #6615).
 * Shared by the main process that reads it and the screen that shows it.
 */

export interface ExtensionProgramFailure {
  /** `tool`: a call failed; `outdated`: the installed version of the App needs an update before its program can run. */
  kind?: 'tool' | 'outdated';
  server: string;
  at: string;
  /** The program's own last line on stderr, when it said anything — usually the actual reason. */
  said: string | null;
  /** The program could not be started at all (not found, not executable). */
  notStarted: boolean;
  /** Its exit code when it stopped on its own. */
  code: number | null;
  /** What was run, for "could not find X". */
  command: string;
  /** The program's own last words on stderr — usually the actual reason. */
  stderrTail: string;
}

export interface ExtensionAgentStatus {
  /** Programs of this extension running at this moment, each shared by every agent session. */
  running: number;
  /** The latest program that failed in this run of gugu, if any. */
  lastFailure: ExtensionProgramFailure | null;
}
