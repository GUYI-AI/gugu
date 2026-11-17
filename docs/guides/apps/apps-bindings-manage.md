# gugu.bindings — managing the agent's files and voice notes, drafts carrying files

The same binding as `apps-bindings-agent`: the person's private conversation with their personal assistant, desktop only.
API 50: every `unavailable` carries `reason`: `stale`, `not-applied`, `timed-out`, `unreadable`, `access-unverified`,
`owner-unknown`, `too-large`. Each call below, in a click, your page only; `key` as `resources` gives it:
- `"resources:write"` with `"files"`: `bindings.upload("main", { folder? })` opens gugu's file picker (50 MB, no video, audio or archive)
  → `{ state: "done", uploaded: [{ key, name, receipt }], refused: [{ name, why }] }` | `cancelled`; `bindings.createFolder("main", key)` →
  `committed` | `exists`; `bindings.rename("main", key, to)` → `{ renamedTo, receipts }` | `missing` | `exists`; `bindings.removeFolder("main", key)`
  → gugu asks the person first: `committed` | `cancelled`.
- `"voice-notes:manage"` (`chat:voice-notes:manage`, needs `"voice-notes"` read), `key` the note's id:
  `transcribeVoiceNote` → `started` | `not-waiting` | `busy` | `not-ready` (its home not reachable now: try later);
  `removeVoiceNote` (gugu asks) → `committed` | `cancelled`; `exportVoiceNote` (gugu's save dialog) → `saved` | `cancelled`.
- A draft carries files: `gugu.dispatch(text, { draft: true, to: { binding: "main" }, attach: [{ file: path } | { domain, key }] })`,
  up to 9, each one you may read (`"files"` / that domain). Pills in the composer; nothing is sent.
