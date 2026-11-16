# gugu.assistant, toast — the person's own assistant, and gugu's toast

Through the binding of `apps-bindings` (`chat:unread`, the one conversation the person chooses), when that
conversation is the person's private chat with their own assistant (`apps-bindings-agent`): the assistant itself.
API 44, only when that conversation is the person's private chat with their own assistant (else `denied`): add
`"assistant-status"` (`assistant:status`), `"assistant-open"` (`assistant:open`), `"assistant-rename"` (`assistant:rename`).
- `gugu.assistant.status("main")` → `{ state: "ready", status, hostPage }` | `{ state: "unbound" | "unavailable" }`;
  `gugu.assistant.onChanged(fn)` hears each new one. `status`: `{ assistant: "found"|"loading"|"none"|"unreadable", name, avatar
  (data: image), tint (hue 0–360|null), home: { kind: "cloud"|"this-computer"|"other-computer"|"server", online, label } | null,
  setup: "shell"|"connect"|"ready"|null, preparing, cloudAvailable, member: boolean|null, loadError, ownerName, nameMax (30),
  counts: { devices, connectedApps (value { saved, connected }), projects }, connectors }` — no id. Each count and
  `connectors` is `{ state: "ready", value }` | `{ state: "loading" }` | `{ state: "unreadable" }` (say gugu's "can't read it now");
  `connectors` value: the connect step's rows `{ id, name, icon: { light, dark, invertInDark } | null (data: images), connected }`.
- With no assistant yet (`none`, `loading`, `unreadable`): `ready` with any or no conversation, `name`, `avatar`, `tint`, `home`,
  `counts`, `connectors` null, and `gugu.assistant.open("main", "setup")` works. Once one appears, unchosen: `onChanged` hears `{ state: "unbound" }` once.
- In a click: `gugu.assistant.open("main", screen)` — gugu's screens `close`, `look`, `model`, `devices`, or the assistant's
  own pages `setup`, `move`, `settings`, `connected-apps`, `projects` drawn over your page with gugu's back control
  (`hostPage` true until closed: hide yours; `setup` starts at the name, your intro being its first screen, and closes once the
  assistant is there). None of these is in gugu's Settings. `gugu.assistant.advanceSetup("main", "ready" | "done")`: from `connect`, or `ready` to done; else `invalid`.
  `gugu.assistant.rename("main", text)` → `"renamed"|"unchanged"|"empty"|"too-long"|"failed"` (trimmed, ≤ `nameMax`).
  `gugu.assistant.connect("main", id)`: that row's connect dialog, as gugu's connect step (`id` from `connectors`, else `not-found`).
- `gugu.assistant.figure("main", { x, y, size } | null)`: gugu draws the assistant moving (none yet: the setup bird) over your
  page at x, y (CSS px), size 16–512, clipped, clicks pass through; say it again when your layout moves, null removes it.

Free (API 44, desktop page): `toast(text)` → one line in gugu's own toast, as its "Changes saved": ≤ 80 characters,
text only, while your page is on screen and focused (else `denied`), one every 2 s (else `rate-limited`).
