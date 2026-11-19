/**
 * The record lines a rewind left behind in a Claude transcript (#2970).
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
 */
export class ClaudeBranches {
  private readonly order: string[] = [];
  private readonly position = new Map<string, number>();
  private readonly firstChild = new Map<string, string>();
  readonly abandoned = new Set<string>();

  see(record: Record<string, unknown>): void {
    const uuid = record.uuid;
    if (typeof uuid !== 'string' || record.isSidechain === true || this.position.has(uuid)) return;
    const parent = typeof record.parentUuid === 'string' ? record.parentUuid : null;
    const earlier = parent ? this.firstChild.get(parent) : undefined;
    if (parent && earlier === undefined) this.firstChild.set(parent, uuid);
    if (parent && earlier !== undefined && isPersonPrompt(record)) {
      for (let index = this.position.get(earlier)!; index < this.order.length; index += 1) this.abandoned.add(this.order[index]!);
      this.firstChild.set(parent, uuid);
    }
    this.position.set(uuid, this.order.length);
    this.order.push(uuid);
  }
}

function isPersonPrompt(record: Record<string, unknown>): boolean {
  if (record.type !== 'user' || record.isMeta === true) return false;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.length > 0
    && content.every(block => (block as { type?: unknown })?.type !== 'tool_result');
}
