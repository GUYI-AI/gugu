import type { RecordNode } from './record-tree';

/**
 * What a Claude transcript line is on the conversation tree (`record-tree.ts`, which decides the branch kept).
 *
 * A rewind (SDK `resumeSessionAt`, the TUI's `/rewind`) does not delete anything: the next prompt is written with its
 * `parentUuid` pointing back at the turn kept, so the turns after it stay in the file as a branch nobody continues
 * (measured on Claude CLI 2.1.326; fixture `claude-rewound-session.jsonl`). Only a person's prompt can start such a
 * branch: tool results, attachments and hook lines chain one after another, and a tool result beside a parallel call is a
 * side leaf, not a fork. Sidechain lines are not on the main chain.
 *
 * A revert through claude-agent-acp (`_session/revert`) writes one more line at the point kept: a user line whose text is
 * `REVERT_MARK`, so the revert is on disk before anything is sent again. That line forks by itself (`rewind`), so the
 * turns removed are abandoned even when nothing was sent after the revert. It is not something anyone said: it, the
 * attachment lines hung under it and the synthetic answer Claude Code gives it (`No response requested.`) make no entries.
 */
/** claude-agent-acp's `REVERT_MARK` (1.7.1); a test compares it with the installed bridge. */
export const CLAUDE_REVERT_MARK = '(The conversation was stepped back to this point. The turns after it were removed.)';

/**
 * The record's tree node (null: not on the main chain) and whether it is a revert's own line, which makes no entries.
 * `marks` collects the uuids of revert marks and the lines hung under them.
 */
export function claudeLine(record: Record<string, unknown>, marks: Set<string>): { node: RecordNode | null; own: boolean } {
  const uuid = record.uuid;
  if (typeof uuid !== 'string' || record.isSidechain === true) return { node: null, own: false };
  const mark = isRevertMark(record);
  // The lines Claude Code hangs under the mark before its synthetic answer (tool and MCP deltas) belong to the mark too.
  const own = mark || ((record.type === 'attachment' || isSynthetic(record)) && marks.has(record.parentUuid as string));
  if (own) marks.add(uuid);
  const parent = typeof record.parentUuid === 'string' ? record.parentUuid : null;
  return { node: { id: uuid, parent, kind: mark ? 'rewind' : isPersonPrompt(record) ? 'prompt' : 'line' }, own };
}

function isRevertMark(record: Record<string, unknown>): boolean {
  if (record.type !== 'user') return false;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (content === CLAUDE_REVERT_MARK) return true;
  return Array.isArray(content) && content.length === 1 && (content[0] as { text?: unknown })?.text === CLAUDE_REVERT_MARK;
}

function isSynthetic(record: Record<string, unknown>): boolean {
  return record.type === 'assistant' && (record.message as { model?: unknown } | undefined)?.model === '<synthetic>';
}

function isPersonPrompt(record: Record<string, unknown>): boolean {
  if (record.type !== 'user' || record.isMeta === true) return false;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.length > 0
    && content.every(block => (block as { type?: unknown })?.type !== 'tool_result');
}
