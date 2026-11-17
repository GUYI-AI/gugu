# External session history and observed context

Needs `agents:history:all` (API 17, including external CLI sessions):

- `gugu.sessions.index({ project?, source?, offset?, limit?, device?, groupPaths? })` →
  `{ rows, groups, total, pending, stale, nextOffset }`. Rows: `{ source, providerSessionId, title, cwd, updatedAt, sizeBytes, filePath, group: { key, label, repositoryUrl? } }`.
  Grouping matches task history: repository/worktree, registered project, or `gugu:task-home` for standalone tasks; unknown cwd has a null key.
  `groupPaths` accepts absolute directories, including zero-task paths; `groups:[{path,group}]` uses the same grouping.
  `repositoryUrl` is the normalized origin from registered project remotes or native Git; absent means no cross-machine repository identity.
  Sources are `claude-code` / `codex`; subagents are excluded by the host's import parser.
  `project` is a project id or absolute cwd on that machine, matched exactly; worktrees are separate.
  `pending > 0`: indexing is incomplete; call again. Page with offset/limit; default 100 rows.
- `gugu.sessions.read({ filePath, source, offset?, limit?, view?, device? })` reads only an indexed path within the source's
  native transcript roots. Default conversation view: `{ source, providerSessionId, title, cwd, fileName, turns, total, nextOffset }`;
  turns are `{ role, content, createdAt }`, default 50. No thinking/tool output.
  `view:'context'` instead returns compact `loaded, nested, refs` with the same metadata, no bodies:
  loaded `[{path:null|string,kind:'instruction-file'|'rendered-total'|'base-instructions',scope:null|string,chars,truncated,at}]`;
  nested `[{path,at}]`; refs are distinct paths from file/shell tool inputs, including Codex code-mode exec. Claude records rendered totals and instruction
  attachments; Codex records base instructions and world_state AGENTS.md snapshots. Missing observations stay absent.
  Timestamps can be null. Context is one summary per transcript, not a turns page.
- Both follow a task's machine by default; `device:'device:<id>'` explicitly chooses a computer without any task.
  It must have this same App/version and grant this permission. Cross-machine requests/answers are at most 1 MB; page large results.

