# gugu.bindings — the agent behind the chosen conversation

The binding of `apps-bindings` (`chat:unread`, the one conversation the person chooses), when that conversation is the
person's private one with an agent of theirs or their own assistant: more actions on it, each with its own capability,
consented and withdrawn on its own; `get` lists the granted ones in `actions`.
API 42, when that conversation is the person's private one with their personal assistant: `"resources"` (`chat:resources`)
and `"resources:write"` (`chat:resources:write`) reach its resources, each with its domains:
`domains: { "resources": ["memory", "files", "personality", "skills", "voice-notes"], "resources:write": ["memory"] }`
(write: only domains also read, never voice-notes). Any other conversation is `denied`. An update listing more domains asks again.
- `gugu.bindings.resources("main", "memory")` → `{ state: "ready", revision, resources: [{ key, revision, updatedAt, data }] }`.
  `gugu.bindings.resource("main", "memory", key)` → `{ state: "ready", resource, content, truncated, totalSize, binary? }`.
  Otherwise `unbound`, `unprepared` (not published yet), `unavailable` (try later), or `missing` with the `revision` a
  save expects (`"0"`; a deleted one's tombstone, `deleted: true`).
- `gugu.bindings.save("main", { domain, key, operationId, expectedRevision, content })` /
  `gugu.bindings.remove("main", { domain, key, operationId, expectedRevision })` → `{ state: "committed", receipt: { operationId,
  revision, status } }` (`pending` until the agent's machine applies it), or `conflict` (read again), `deleted`,
  `unavailable`, `unbound`. `operationId` is your UUID: the same call again answers the same receipt, status now.
- `gugu.bindings.onResourcesChanged("main", fn)` → unsubscribe; `fn` hears `{ state: "changed" }`: read again, or
  `{ state: "ended" }`: the grant, account or chosen conversation changed — call `get` again.
API 43, when that conversation is the person's private one with an agent of theirs: `"schedules"` (with `chat:schedules`)
and `"schedules:control"` (with `chat:schedules:control`; needs `"schedules"` too) — that agent's schedules, the ones its
own `schedule_*` tools and the person's list show: on this computer, or the person's assistant's wherever it lives. Another
chat, or someone else's agent: `denied`.
- `gugu.bindings.schedules("main")` → `{ state: "ready", schedules }`, each `{ id, revision, title, prompt, at, cron, tz,
  state: "active" | "paused" | "ended", nextRunAt, lastRun: { status, at } | null, updatedAt }`; or `unbound`,
  `elsewhere` (an agent, not the assistant, lives on another computer) or `unavailable` (try again later).
- `gugu.bindings.onSchedulesChanged("main", fn)` → unsubscribe: they changed, list again. Silent for good once the grant goes.
- `gugu.bindings.controlSchedule("main", { operationId, op, … })`, `op`: `register` (`prompt`, `title?`, `at` or `cron`,
  `tz?`), `update` (`title` and/or a new time; what it asks stays the agent's), `pause`, `resume`, `remove` — those four
  with `scheduleId` and the `revision` you read. → `{ operationId, op, status, scheduleId, revision, at }`: `applied`,
  `conflict` (changed since: list, decide, new `operationId`) or `missing`. The same `operationId` again answers the same
  receipt, never a second change. A run under way is never stopped (`remove` then: `unavailable`). Closing your page,
  disabling or uninstalling your App leaves the schedules as they are. The assistant living elsewhere: `pause`, `resume`,
  `remove` only (else `elsewhere`), first `pending` until its computer applies it — the same `operationId` again tells
  `applied`, `failed` or `superseded` (a later change replaced it).
API 44, the assistant itself (`gugu.assistant`: its status, gugu's screens over your page, setup, rename, its moving
figure): `guide_read apps-assistant`.
API 46, the assistant's 任务 list: add `"work"` (with `chat:work`). Only while the chosen conversation is the person's private
chat with their own assistant; any other is refused (`denied`). The host keeps the ledger; it reads it as its own list does,
wherever the assistant lives (this computer, another, the cloud).
- `gugu.bindings.work("main")` → `{ state: "ready", items, stale, open }`, items newest first, each
  `{ handle, title, naming, status, unseen, updatedAt }`: `naming` = draw "naming…" for the title; `status` =
  `{ status, detail }` as an agent's state is drawn, or null; `unseen` = idle with news; `stale` = the last refresh failed,
  these are the last rows read. Else `{ state: "unavailable", open }` (not read yet / cannot be: wait for the event) or
  `{ state: "unbound" }`. `gugu.bindings.onWorkChanged("main", fn)` hears every new answer.
- `handle` is opaque: this App, this account, this choice of conversation; read again after a restart. No work, session,
  chat or device id, path, URL or message.
- `gugu.bindings.openWork("main", handle)` in a click: the host draws that task's conversation in your panel, over your
  page, with its own back control; `gugu.bindings.closeWork("main")` takes it away. `open` is that row's handle while it is
  drawn, else null — hide your list then. You cannot see it. Another account, a withdrawn grant, a new choice: it closes.

The same assistant chat, drawn by the host: its top row (`header`, 46), its voice-note recorder (`gugu.voiceNote`, 47),
your entries in its composer "+" (`composerActions`, 48): `guide_read apps-bindings-assistant`.
