# gugu.bindings on a phone (API 49)

List `"phone"` in `platforms` with the binding, at `apiVersion` 49 (earlier: refused). A phone has no picker: it binds only gugu's own
assistant App (`gugu-assistant`, from the market) to the account's private chat with its own assistant; any other App's binding is
`unbound` there. Calls answer as on a computer — files, draft, resources, schedules, `gugu.assistant`, work, `toast` — as the
person signed in on that phone, checked again after every wait.

- Layout: `gugu.bindings.surface("main")` is `{ state: "bound", layout: "side-panel", panel }` on a computer and
  `{ state: "bound", layout: "phone", section, hostPage }` on a phone. There gugu draws the layer, its header and its tabs: `聊天` is
  the conversation (gugu's; you never see it), and your main page fills the others, full screen inside the safe areas. `section` is
  `today`, `tasks`, `memory` or `profile` (behind the assistant's face): draw that section's phone layout, with no tab row and
  no header of your own. `hostPage`: one of the phone's own screens covers your page now. `gugu.bindings.onSurface(fn)` hears
  each move; `gugu.bindings.setPanel("main", { section })` moves the layer; `gugu.navigation.onBack(fn)` holds Back for your steps.
- `{ state: "unsupported" }` — closed, not an error, the same if asked again: hide that control on a phone. It answers
  `gugu.bindings.setPanel("main", { collapsed })`, `gugu.assistant.open("main", "move")` (a phone is never its home), `advanceSetup`,
  `gugu.assistant.figure` (the layer's header draws the face) and every `gugu.voiceNote.*` (聊天 records with the phone's own
  recorder). Composer entries (`composerActions`) and `unreadSource` draw nothing there: 聊天 keeps the phone's own 「+」.
- `onSurface` also brings `intent` there, once: `{ kind: "voice-note" }` when the person opens the note the recording bar shows
  (the layer is on `memory`; read it through `voice-notes`), `{ kind: "profile" }` from the assistant's 自定义 card (on `profile`).
- `gugu.assistant.open` opens the phone's own screens: `setup` and `settings` its settings page, `look` its 换形象 page,
  `model`, `devices`, `connected-apps`, `projects` theirs under 资料, `health` its 健康 page under 记忆,
  `close` the one confirmation. `gugu.assistant.rename` works as on a computer. `gugu.bindings.openWork` draws the task's
  conversation over 任务, with its own back. A `{ binding }` draft lands in 聊天 and the layer goes there.
- Health: read on the phone and never handed to you. Draw a 健康 row or card with no figures; on a click,
  `gugu.assistant.open("main", "health")`. A computer answers `unsupported`: hide it there.
- Files: `gugu.bindings.list` / `read` (the chat's own folder, by path), the `files` / `memory` / `voice-notes` resources and
  `save` / `remove` work. API 50's `upload` (the phone's picker) and `removeVoiceNote` (the phone asks first) work;
  `createFolder`, `rename`, `removeFolder`, `transcribeVoiceNote`, `exportVoiceNote` and a draft's `attach` answer
  `unsupported` on a phone (a draft with `attach` places nothing): hide those controls there.
- Schedules: the assistant always lives elsewhere seen from a phone; pause, resume and remove go through its panel (`pending`
  until its home applies them); adding or retiming one is asked of the assistant (`invalid`).
