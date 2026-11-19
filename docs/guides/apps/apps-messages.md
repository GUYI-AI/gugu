# gugu.chats, gugu.messages — the chats you are in, and what was said

Which chats the reader is in and who is in one — for a page that is in no chat (an App's own tab, full screen) to
offer one — and what people and agents said in a chat: a stretch of its timeline, one thread, or the messages that
cite a file (a pill, a link) — "this passage was discussed 3 times", each a click away with `gugu.showMessage(m.id)`.

Needs `chat:read` (manifest `apiVersion` 6) — any chat the reader is in, and only what they can see there (the doors an agent's
`message_conversations`, `message_members` and `message_history` take: whispers to others and what came before
they could see it are not there). A page reads as the person, or as the agent working it. An agent's call to your
program reads as that agent: `chats.list` its chats, the rest only a chat it handed (`gugu-chat`) or a file in it
(`gugu-file`) — any other is `denied`; outside any call, as the person. A phone too.

- `gugu.chats.list()` → `{ chats: [{ id, name, kind, lastMessageAt }] }`, all of them, last spoken first: `kind`
  `group` / `topic` / `dm` (a private chat's `name` is the other one's), `id` what every `chat` below takes.
- `gugu.chats.members({ chat })` → `{ members }`: `{ id, name, kind, avatar? }`.

- `gugu.messages.history({ chat, thread?, before?, limit? })` → the timeline (`thread`: its first message's id, for
  that thread alone), newest first.
- `gugu.messages.search({ chat, query } | { chat, file }, …)` → the messages, threads too, holding `query` or citing
  `file` (an entry or its id), newest first. Same `before` / `limit`.
- Both answer `{ messages, next }`: pass `next` back as `before` for the older page; `null`, there is none.
  `limit` 1–100 (50). A chat the reader is not in has none.
- A message: `{ id, seq, chat, thread, sender: { id, name }, text, contentType, createdAt, refs }`. `sender.id` is
  `user:<uuid>`, as `gugu.chats.members()`; `null` for a line gugu wrote (`system`: someone joined). `text` is as written. `refs` is every file link in
  it, read for you: `{ file, version?, at? }` — `at` is the place your `refs` named.

`{ file }` finds every message citing that file, anywhere in it. To count one place, keep the ones whose `at` is that
place — the search does not:

```js
async function discussed(chat, file, h) {
  const found = []
  for (let before; ; ) {
    const page = await gugu.messages.search({ chat, file, before, limit: 100 })
    found.push(...page.messages.filter((m) => m.refs.some((r) => r.file === file.id && r.at?.h === h)))
    if ((before = page.next) === null) return found
  }
}
```

Nothing is pushed: read again when your page opens or shows again (`onContextChanged`).
