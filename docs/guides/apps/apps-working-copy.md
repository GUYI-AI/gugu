# A session's working copy through gugu.files

The place is `{ workspace: ctx.workspace.id }`. An entry's `id` is its path there; it carries `absolutePath`, and `gitStatus` when git says it changed.

- `gugu.files.list({ workspace, folder })` lists one folder (`''` the top), never a whole tree. Non-documents: `f.read(offset, length)`, `f.blob()`.
- `gugu.files.onChanged({ workspace, folder }, fn)`: `{ kind: 'changes', changes }` or `resync`, below `folder` only.
- `gugu.files.openWith({ workspace, folder })` (a click or key): that folder in the Files App's list, in this tab.
- Another machine's working copy needs `files:read:all-machines` as well; every call below is done on that machine.
- With `files:write`: `gugu.files.create`, `gugu.files.rename` (a path moves it), `gugu.files.mkdir({ workspace, path })`, `gugu.files.move(entry, { folder, name })`, `gugu.files.remove` (a folder with all in it; a link, not what it points at). A name already there: `name-taken`, nothing changed.
- `gugu.files.upload({ workspace, folder }, file, { replace, onProgress, signal })`: a File or a list of them, in parts, of any size, folders made as needed. A name already there is `name-taken` until `replace: true`. `onProgress` is told the bytes sent and the total; an aborted `signal` leaves nothing.
- `gugu.files.download(entry, { onProgress, signal })` (a click or key): a file, or a folder with all in it (`{ skipped }`: its links that were left out); `onProgress` is told the bytes saved and the total; an aborted `signal` leaves nothing.
- `gugu.files.reveal(entry)` / `gugu.files.openInApps()` / `gugu.files.openIn(entry, id)` (a page, this computer's working copy): the file manager; the programs it opens in. `gugu.files.openIn({ workspace, id: '.' }, id)`: the working copy's own folder. A `showContextMenu` row's `program: id` (API 51) draws that program's icon.

A text no live document holds (over 1 MiB, JSON that is no object, on another machine, outside the working copy) is read and saved whole. Nothing is needed for `ctx.file`, which may be an absolute path; any other file needs `files:read` / `files:write`, and no capability opens another absolute path (`denied`).
- `gugu.files.readText(file, { maxBytes, onProgress })` (`onProgress`, a page's: told the bytes done and the total) → `{ entry, content, truncated, totalSize, binary?, exact? }`. Up to 20 MiB unless told, at most 100 MiB; over that, `truncated` and no content. `binary`: it is not text. `exact: false`: another encoding, which saving would change: show it read-only.
- `gugu.files.writeText(file, text)` saves over the version `readText` read: `content-changed` if the disk moved on, so read it, merge, save. A file deleted since is made again. `unavailable`: its machine cannot be reached; `machine-outdated`: it is too old for this call, and the host offers to update it. `error.detail.machine` names it in both.
- `gugu.files.exists(file)`: whether it is there now.
- `gugu.files.onChanged({ workspace, id }, fn)`: one file, by the name you gave. `resync`: anything may have changed (its machine is back). A file outside the working copy on another machine sends nothing.
- API 54, preinstalled Files App only: `gugu.files.sendSelection({ text, refs, rect, viewport })`, inside a real click/key, opens the host's Send box beside the selection (`rect` and `viewport` in the page's CSS px; `refs` 1–8 files of this page's session working copy, as a draft's). The host shows `text` and the pills as they will be sent, the person adds words and @, and the host sends into the page's session. Answers `'sent'` or `'cancelled'`, nothing else. Before any other App may call it, re-review that the person sees every word of `text` (it goes out as theirs).
- After `rename`, `move` or `remove`, the host's panes that show the file follow it.
- `gugu.files.draft(file, text)`: keep a file's unsaved edits on its machine for after a crash: without `text` it reads them, with `null` it drops them.
- `opensFiles.session: ["*"]`: any file, behind every other claim.

Free, for a page that edits files:
- `setTabDirty(tabId, dirty)`: a tab of yours (`ctx.tabId`) holds unsaved edits: a dot, kept mounted, asked before closing. `onCommand` hears `gugu.file.save:<tabId>` / `gugu.file.discard:<tabId>`; do it, then say `setTabDirty` again.
