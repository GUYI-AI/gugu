/**
 * Deterministic PTY session ID.
 *
 * Format: `<workspaceId>:<scopeId>:<leafId>` where leafId is either a
 * conversationId (agent sessions) or a terminalId (shell sessions).
 *
 * There is at most one active PTY per leaf entity.  Using a deterministic ID
 * means the renderer can subscribe to ptyDataChannel BEFORE calling
 * rpc.sessions.startSession / rpc.terminals.createTerminal — no extra
 * round-trip is needed to learn the session ID.
 *
 * PTYs started by earlier releases carry a local project id as the first part; their tmux sessions are found again
 * through the legacy project aliases (main process, `resolveTmuxSessionName`).
 */
export function makePtySessionId(workspaceId: string, scopeId: string, leafId: string): string {
  return `${workspaceId}:${scopeId}:${leafId}`;
}

export interface ParsedPtySessionId {
  workspaceId: string;
  scopeId: string;
  leafId: string;
}

export function parsePtySessionId(id: string): ParsedPtySessionId | null {
  const parts = id.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return { workspaceId: parts[0], scopeId: parts[1], leafId: parts[2] };
}
