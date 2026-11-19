/**
 * The record lines a revert left behind in a Claude transcript.
 *
 * A rewind (SDK `resumeSessionAt`, the TUI's `/rewind`) does not delete anything: the next prompt is written with its
 * `parentUuid` pointing back at the turn kept, so the turns after it stay in the file as a branch nobody continues
 * (measured on Claude CLI 2.1.326; fixture `claude-rewound-session.jsonl`). The conversation is the path to the newest
 * line; this tracker, fed every record in file order, says which uuids belong to abandoned branches.
 *
 * A branch is recognised only where a person's prompt hangs off a node that already had a child: that is the shape a
 * rewind writes, and ordinary appends never produce it (tool results, attachments and hook lines chain one after another).
 * Every main-chain line between that earlier child and the new prompt belongs to the abandoned branch, because a
 * transcript has one writer and the old branch stops growing at the rewind. Sidechain lines are not on the main chain.
 * It reads nothing itself: the reader feeds it the records it decodes anyway.
 *
 * A revert through claude-agent-acp (`_session/revert`) writes one more line at the point kept: a user line whose text is
 * `REVERT_MARK`, so the revert is on disk before anything is sent again. That line is a person prompt hanging off a node
 * that already had a child, so it opens the new branch by itself, and the turns removed are abandoned even when nothing
 * was sent after the revert. It is not something anyone said: it and the synthetic answer Claude Code gives it
 * (`No response requested.`) make no entries.
 */
/** claude-agent-acp's `REVERT_MARK` (1.7.1); a test compares it with the installed bridge. */
export const CLAUDE_REVERT_MARK = '(The conversation was stepped back to this point. The turns after it were removed.)';

export class ClaudeBranches {
  private readonly order: string[] = [];
  private readonly position = new Map<string, number>();
  private readonly firstChild = new Map<string, string>();
  readonly abandoned = new Set<string>();
  private readonly marks = new Set<string>();

  /** Takes in one record; true = it is a revert's own line, which makes no entries. */
  see(record: Record<string, unknown>): boolean {
    const uuid = record.uuid;
    if (typeof uuid !== 'string' || record.isSidechain === true) return false;
    const own = isRevertMark(record) || (isSynthetic(record) && this.marks.has(record.parentUuid as string));
    if (own) this.marks.add(uuid);
    if (this.position.has(uuid)) return own;
    const parent = typeof record.parentUuid === 'string' ? record.parentUuid : null;
    const earlier = parent ? this.firstChild.get(parent) : undefined;
    if (parent && earlier === undefined) this.firstChild.set(parent, uuid);
    if (parent && earlier !== undefined && isPersonPrompt(record)) {
      for (let index = this.position.get(earlier)!; index < this.order.length; index += 1) this.abandoned.add(this.order[index]!);
      this.firstChild.set(parent, uuid);
    }
    this.position.set(uuid, this.order.length);
    this.order.push(uuid);
    return own;
  }
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
