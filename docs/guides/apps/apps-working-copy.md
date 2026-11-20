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
- API 60, any page: an opened file (`gugu.files.open`) carries its selection menu, the host's table for this page (Copy · Cite · Send, in order, in the person's language). `gugu.files.showSelection({ file, places, text?, code?, rect })` draws it in the page at the selection (`rect` in the page's CSS px; call again as the selection moves, scroll included — it moves in the same frame; `null` takes it away). It is not drawn while the pointer is still selecting or while the selection is out of view. `places` (1–8) are `{ at, label? }` as `gugu.dispatch` refs take them, one pill each: lines are `{ at: { lines: '3-4' } }` and the host names them; any other place (`{ sheet, cell }`, `{ slide, shape }`) carries its `label` in the reader's language. Copy shows only with `text`. A press on Cite or Send hands the selection to the host in the person's gesture: Cite drafts into the page's conversation, Send opens the host's own box at the selection and only the person sends from it. A page an agent works has no menu (`denied`).
- After `rename`, `move` or `remove`, the host's panes that show the file follow it.
- `gugu.files.draft(file, text)`: keep a file's unsaved edits on its machine for after a crash: without `text` it reads them, with `null` it drops them.
- `opensFiles.session: ["*"]`: any file, behind every other claim.

Free, for a page that edits files:
- `setTabDirty(tabId, dirty)`: a tab of yours (`ctx.tabId`) holds unsaved edits: a dot, kept mounted, asked before closing. `onCommand` hears `gugu.file.save:<tabId>` / `gugu.file.discard:<tabId>`; do it, then say `setTabDirty` again.

## Selection menu

What the host's selection menu offers comes from the page's conversation — its session, else the chat it is drawn in — and the file: Copy when there are words; Cite when there is a conversation and the file can be named for its readers; Send also needs a surface that can send (a phone's task page cites only). A file is named where it lives: a chat folder's by its `gugu-file://` link, a computer's (a working copy, a project or group folder) by its absolute path on that machine. Cite puts the words and a pill per place into the conversation's composer; Send puts the same with the person's own line into the conversation once they send it. The host's own text preview draws the same menu.
