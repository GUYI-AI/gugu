import type { RecordEntry, SessionRecordLocator, SessionRecordSource } from '../contract';
import { createJsonlTailSource } from './jsonl-tail-source';
import { RECORD_START, type RecordNode } from './record-tree';
import type { SessionRecordSourceOptions } from './shared';

/**
 * 树形 JSONL 会话记录(pi、qwen、codebuddy):每行一个条目，条目经「自己的 id / 父 id」连成一棵树。
 * 时间线读的是到最新一行的那一条路径;回退留下的旧分支由共用的树层丢掉(`record-tree.ts`),读法与 codex 同一个源。
 *
 * 各家只给三样:一行怎么认成树上的节点(`toNode`,不在树上的行回 null)、它是不是一句人说的话或一次回退(`kind`)、
 * 一个节点怎么解成记录条目(`decode`)。
 */
export type TreeNode = { id: string; parentId: string | null; raw: Record<string, unknown> };

export type TreeJsonlFormat = {
  /** 写进告警里的那一家的名字。 */
  name: string;
  toNode(raw: Record<string, unknown>): TreeNode | null;
  kind(node: TreeNode): RecordNode['kind'];
  decode(node: TreeNode): RecordEntry[];
};

export function createTreeJsonlSource(
  locator: SessionRecordLocator,
  options: SessionRecordSourceOptions | undefined,
  resolve: () => Promise<string>,
  format: TreeJsonlFormat
): SessionRecordSource {
  return createJsonlTailSource<null>(locator, options, {
    name: format.name,
    // 2: prompts carry their revert points (CodeBuddy, Qwen); state saved before that has none.
    resumeVersion: 2,
    resolve,
    initial: () => null,
    node(raw) {
      const node = format.toNode(raw);
      // A node with no parent hangs off the start: a rollback to there (CodeBuddy's fork notice with no parent) abandons all.
      return node && { id: node.id, parent: node.parentId ?? RECORD_START, kind: format.kind(node) };
    },
    decode(raw) {
      const node = format.toNode(raw);
      return node ? format.decode(node) : [];
    }
  });
}
