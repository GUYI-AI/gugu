/** Host-only projection vocabulary. Unbounded content stays a field capability;
 * these facts are deliberately not a partial TranscriptItem cast. */
export type CommitHeaderScalar = string | number | boolean | null;
export type CommitHeaderRange = { start: number; end: number };
export type CommitHeaderTarget = 'turn' | 'item' | 'terminal';
export type CommitHeader = {
  target: CommitHeaderTarget;
  values: Record<string, CommitHeaderScalar>;
  deferred: Array<{ field: string; kind: 'string' | 'array' | 'object'; range: CommitHeaderRange }>;
};
const commonTool = 'id seq kind toolCallId title toolKind toolName status at completedAt inputSummary backgroundTaskId backgroundTaskDone parentToolCallId locations contentBlocks images imageRefs';
const tool = (extra = '') => `${commonTool} ${extra}`;
export const COMMIT_ITEM_HEADER_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  message: 'id seq kind role at attachments files ownerNotification revertAnchor content',
  thinking: 'id seq kind segmentId status startedAt durationMs content',
  compaction: 'id seq kind compactionId status startedAt trigger preTokens postTokens durationMs summary error',
  'context-reset': 'id seq kind reason at',
  'session-notice': 'id seq kind code detail effectiveValue previousValue title at',
  'tool-group': 'id seq kind label groupKind status',
  'execute-tool-call': tool('command terminalId exitStatus'),
  'read-tool-call': tool('path resource'),
  'patch-tool-call': tool(),
  'search-tool-call': tool('query matchCount'),
  'mcp-tool-call': tool('server tool'),
  'web-fetch-tool-call': tool('url pageTitle'),
  'spawn-subagent-tool-call': tool('subagentSessionId agentStatus agentStartedAt canCancel reasoningText name background agentId model startedAt'),
  'subagent-done-tool-call': tool('name agentId launchToolCallId outcome summary outputFile'),
  'background-command-done-tool-call': tool('name launchToolCallId outcome summary'),
  'create-plan-tool-call': tool('planId'),
  'unknown-tool-call': tool('name'),
});
const turn = 'id seq referenceId initiator startedAt endedAt outcome trigger foreground';
const terminal = 'terminalId owner canKill command args cwd outputBytes truncated exitStatus';
export const COMMIT_HEADER_CHILDREN: Readonly<Record<string, string>> = Object.freeze({
  'turn:outcome': 'kind reason detail signInRequired guguReason said',
  'turn:trigger': 'kind chatIds',
  'terminal:exitStatus': 'exitCode signal',
  'item:exitStatus': 'exitCode signal',
});
const names = (s: string) => s.trim().split(/\s+/);
export function commitHeaderFields(target: CommitHeaderTarget, kind?: string) {
  if (target === 'item' && kind !== undefined && !Object.hasOwn(COMMIT_ITEM_HEADER_FIELDS, kind))
    throw new Error('Canonical item kind has no header projection');
  return new Set(names(target === 'turn' ? turn : target === 'terminal' ? terminal
    : kind === undefined ? Object.values(COMMIT_ITEM_HEADER_FIELDS).join(' ') : COMMIT_ITEM_HEADER_FIELDS[kind]));
}
export function filterCommitHeader(header: CommitHeader): CommitHeader {
  const fields = commitHeaderFields(header.target, header.target === 'item' ? String(header.values.kind) : undefined);
  const allowed = (path: string) => {
    const [field, child] = path.split('.');
    return fields.has(field) && (!child || names(COMMIT_HEADER_CHILDREN[`${header.target}:${field}`] ?? '').includes(child));
  };
  const values = Object.fromEntries(Object.entries(header.values).filter(([field]) => allowed(field)));
  const deferred = header.deferred.filter(value => allowed(value.field));
  const required = header.target === 'turn' ? ['id', 'seq', 'referenceId', 'initiator']
    : header.target === 'terminal' ? ['terminalId', 'owner', 'canKill', 'truncated'] : ['id', 'seq', 'kind'];
  if (required.some(field => !Object.hasOwn(values, field))) throw new Error('Canonical header identity is incomplete');
  if (header.target !== 'terminal' && !Number.isSafeInteger(values.seq))
    throw new Error('Invalid canonical header sequence');
  const present = (field: string) => Object.hasOwn(values, field) || deferred.some(value => value.field === field);
  const requireFields = (list: string) => { if (list.split(' ').some(field => !present(field))) throw new Error('Canonical rendering fields are incomplete'); };
  if (header.target === 'turn' && !['user', 'agent'].includes(String(values.initiator))) throw new Error('Invalid turn initiator');
  if (header.target === 'item') {
    const kind = String(values.kind);
    if (kind === 'message') {
      if (!['user', 'assistant'].includes(String(values.role))) throw new Error('Invalid message role');
    } else if (kind === 'thinking') {
      requireFields('segmentId startedAt status');
      if (!['thinking', 'done'].includes(String(values.status))) throw new Error('Invalid thinking status');
    } else if (kind.endsWith('-tool-call') || kind === 'tool-group') {
      requireFields(kind === 'tool-group' ? 'label groupKind status' : 'toolCallId title status');
      if (!['running', 'done', 'error', 'unknown'].includes(String(values.status))) throw new Error('Invalid tool status');
      const fields: Record<string, string> = { 'search-tool-call': 'query', 'mcp-tool-call': 'tool', 'web-fetch-tool-call': 'url',
        'spawn-subagent-tool-call': 'name', 'subagent-done-tool-call': 'name agentId launchToolCallId outcome',
        'background-command-done-tool-call': 'name launchToolCallId outcome', 'create-plan-tool-call': 'planId', 'unknown-tool-call': 'name toolKind' };
      if (fields[kind]) requireFields(fields[kind]);
    } else if (kind === 'compaction') requireFields('compactionId status startedAt summary');
    else if (kind === 'context-reset') requireFields('reason at');
    else if (kind === 'session-notice') requireFields('code detail');
  }
  return { target: header.target, values, deferred };
}
