# Header row, gugu.voiceNote, composer actions — the person's own assistant chat

The binding of `apps-bindings` when its conversation is the person's private chat with their own assistant (as
`apps-bindings-agent`): what the host draws there for your App — its top row, its voice-note recorder, your entries in
that conversation's composer "+". Each is told to your page only as `gugu.bindings.onSurface` → `intent`, once, after
the person's click, your panel expanded and any host page over it closed; no data comes with it.

API 46: `contributes.conversationSurface.header: "assistant"`: the host draws the built-in assistant page's top row above
the conversation — its face and name, search, settings gear, expand — from its own data. A click on the face and name:
`intent: { kind: "profile" }`; show its profile. The gear opens the host's settings page over your page. `panel.hostPage`
is true while a host page (that, or a task) is over your page. Another conversation: no row.
Only the product's own assistant App, when it replaces the built-in assistant page: `intent: { kind: "resume", tab }`
(tasks | memory | profile), once, in the first bound `surface` answer or `onSurface` event after the hand-over; open that tab.

API 47: `"voice-notes:record"` (`chat:voice-notes:record`) drives the host's voice-note recorder. The host
records from the microphone, uploads, transcribes and hands the note to the assistant; your page never gets the audio.
- In a click: `gugu.voiceNote.start("main", { meeting? })` → `{ state: "started", job }` or `busy`, `no_assistant`, `cancelled`,
  `mic_denied` (offer `gugu.voiceNote.openMicSettings("main")`, also in a click), `mic_missing`, `capture_failed`, `unbound`.
  `meeting`: `{ title, start, end }` (ISO times). `gugu.voiceNote.resume("main")` and `gugu.voiceNote.retry("main", job)` also take a click;
  `gugu.voiceNote.pause("main")` and `gugu.voiceNote.stop("main")` do not. Each answers the status.
- `gugu.voiceNote.status("main")` → `{ state: "ready", recorder: { phase, elapsedMs, level, silentMs, error }, jobs: [{ job, phase,
  failure: { stage, retryable, reason } | null, createdAt }] }`; `phase` idle|starting|recording|paused|stopping; a job's
  recording|uploading|transcribing|summarizing|ready|failed|no_speech. `job` is an opaque handle for `retry`; transcript
  and summary are read through the `voice-notes` domain (API 42).
- `gugu.voiceNote.onChanged("main", fn)` → unsubscribe; `fn` hears `{ state: "changed", recorder, jobs }` (about 10 a second
  while recording) or `{ state: "ended" }`. A recording goes on when your page closes. Disabled or uninstalled mid-recording:
  the host stops it and keeps the note, and takes no further call from your App; another account: it stops.

API 48: `contributes.conversationSurface.composerActions` adds entries to that conversation's composer
"+", drawn and run by the host on the person's click (no code of yours runs then). Not drawn beside any other conversation.
`[{ id, label: { zh, en } (one line, ≤ 40), icon, chip?, run }]`, at most 6; `icon` one of sparkles, mic, upload, lightbulb, pencil,
heart, checklist, document, book, image, message. `chip: { zh, en }` (one entry at most): also a capsule with that shorter label
at the right end of the row above that composer (the built-in 「灵感」); a click runs the entry; hidden while a note records.
`run`, each needing that binding action (and its capability):
- `{ kind: "voice-note" }` (`voice-notes:record`): the host starts a voice note and says why if it cannot, as its own entry does.
- `{ kind: "draft", text: { zh, en } }` (`draft`): the person's language (≤ 2000) goes after what is in that composer. Nothing is sent.
- `{ kind: "page-intent" }` (`surface`): your page hears `intent: { kind: "composer-action", id }`, that entry's `id`;
  show that view.
The host's recording bar sits above that composer while a note for this assistant records (whoever started it); when the
person opens the note it shows, your page hears `intent: { kind: "voice-note" }` (read it through `voice-notes`).
With `header`, the host's 「自定义<name>」 hint starts that row once after the assistant is set up (gone once opened or
dismissed); opened, your page hears `intent: { kind: "customize" }`: open what customizes it (name, look, character).
