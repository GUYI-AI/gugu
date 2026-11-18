# gugu.bindings — one conversation the person chooses for your App

Needs `chat:unread` (desktop, API 37): declare `permissions.bindings: [{name: "main", kind: "conversation", actions: ["unread"]}]`
and `chat:unread`. The person chooses one conversation in the App's common permission section.
`gugu.bindings.get("main")` returns `state: "bound"` plus an opaque handle, or `state: "unbound"`; it never returns
a chat ID, messages or another conversation. This grants neither `chat:read` nor Agent control.
The host validates the current account, installed publisher, grant and active membership. An App cannot set its own target.
Declare `contributes.unreadSource: {binding: "main"}` for the host rail red dot. It follows the original chat unread source
even before your page opens or after eviction. Opening the App does not mark messages read; page badges still work.
API 40, the same conversation only: add `"files"` (with `chat:files`) and/or `"draft"` (with `chat:draft`) to
`actions`; each is consented and withdrawn on its own, and `get` lists the granted ones in `actions`.
- `gugu.bindings.list("main", { folder? })` → `{ state: "ready", entries }`: one folder by its path (`""` the top; none: all).
  `gugu.bindings.read("main", "today.json")` → `{ state: "ready", entry, content, truncated, totalSize, binary?, exact? }`, text up to 20 MiB.
  Entry: `{ name, path, type, contentType, size, version, createdAt, updatedAt }` — no chat, item id, people or messages.
- Otherwise `state` says why, never an empty list: `unbound` (no conversation chosen), `missing` (no such file or folder),
  `unprepared` (there, its content not stored yet), `unavailable` (cannot be read now: try again later). Read only: no
  write, rename or delete, no other chat; a topic is refused. Paths are names from the top; `..`, absolute paths, ids: `invalid`.
- `gugu.dispatch(text, { draft: true, to: { binding: "main" } })` in a click: the text into that conversation's composer. Nothing is sent.
API 41, your main page beside that conversation: add `"surface"` (with `chat:surface`) and
`contributes.conversationSurface: {binding: "main", placement: "side-panel"}`. The host draws the conversation itself (composer,
streaming, voice, attachments, read state) as the main column; your main page is the collapsible panel on its right.
- `gugu.bindings.surface("main")` → `{ state: "bound", panel: { collapsed, inset } }` while it is drawn beside this page, else
  `{ state: "unbound" }`: none chosen, a grant withdrawn, another account, no longer in it, or your page opened elsewhere.
  `gugu.bindings.onSurface(fn)` hears each change; `gugu.bindings.setPanel("main", { collapsed })` collapses or expands your panel.
- `panel.inset` `{ top, right }` (px): the host's collapse button covers your page's top-right corner, centred in the top
  `top` px, within `right` px of the edge. Make your top row (name, tabs) `top` px high and keep `right` px clear.
- You get no chat, message, person or DOM of it. Opening your page marks nothing read; a `{ binding }` draft lands in that composer.
API 42 to 46, when that conversation is the person's private one with their own agent or assistant (its resources,
schedules, the work it handed out): `guide_read apps-bindings-agent`; the assistant itself (`gugu.assistant`, 44) and
`toast`: `guide_read apps-assistant`; the host's top row over it, its voice-note recorder, your composer "+" entries
(46 to 48): `guide_read apps-bindings-assistant`. On a phone (49): `guide_read apps-bindings-phone`.
Managing its files and voice notes, and drafts carrying files (API 50): `guide_read apps-bindings-manage`.
