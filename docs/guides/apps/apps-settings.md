# Tools-only Apps and host settings

## Platform declarations

Declare human UI hosts in `platforms` (API 12): desktop, phone, or both. A phone UI may declare agent
capabilities; those features run only on computers. Phone plus `notifications` is refused at publication and install.
On a phone, a page with steps of its own (folders) holds Back with `gugu.navigation.onBack(fn)` → a release; let go at the top.

## The agents' line

`contributes.instructions` (<= 160 characters; required with programs or skills, refused without) is your App's
whole line in every new session's `<gugu_apps>`: name the tools that matter and when to read which skill. Longer
standing behavior is a skill whose description says when to read it.

## The personal assistant's product rules (API 45)

`contributes.assistantRules` names a bundle folder holding the personal assistant's product rules as text and data:
`rules.json` (`format: 1`, `rulesVersion`, `defaults` and one-line `labels`) and one `<key>.md` per text, each ending
with one newline. Text files are UTF-8 without a byte-order mark, LF only; `{{slot}}`s are limited per key and filled by
the host. Nothing in the folder runs: the host reads it at its own points and refuses it whole on any unknown key or
file, an unsupported `format`, a bad encoding, a size over its bound or a path leaving the folder.
**It is honoured only for the product's assistant App: id `gugu-assistant`, installed from the market, its code in
gugu's market repository, no fork switched on.** Any other App's folder is never read, so declaring it gives an ordinary
App nothing. The host keeps a copy of the last folder it accepted and goes on using it when that App is switched off,
uninstalled, or a later version's folder is refused.

## Prompts (API 34)

`contributes.prompts`: up to 8 `{ "name", "title", "prompt" }`, plain text the person picks from the composer's `/`
menu under your App's name, edits and sends. Translate with `localized.<tag>.prompts.<name>` (`title`, `prompt`).
It needs no capability. The person's own prompts are behind `prompts` (a program's, for its agent):
`gugu.prompts.list({ query? })`, `gugu.prompts.save({ id?, title, prompt })` and `gugu.prompts.delete(id)` (the
person gets an undo at once). App prompts are read-only here: `list` gives them as the person sees them, their own
version marked `state: "modified"`, none they hid.

## Configuration

An App with only programs or skills may omit `entry` and `contributes.tabs` (API 5). Clicking it
opens the host's configuration/status page. No blank HTML or custom frontend is needed. An HTML App
may also declare `{ "name":"settings", "title":"Settings", "hostPage":"settings" }` as a tab.
Optional top-level `settings` declares up to 32 fields: `{ "key":"mode", "title":"Mode",
"type":"string", "default":"local" }`. Types: `string`, `boolean`, or `select` with
`options:[{"value":"local","title":"Local"}]`; `description` and a typed `default` are optional.
Programs read `JSON.parse(process.env.GUGU_APP_SETTINGS)`. Values survive upgrades; after a change,
new calls start with the new values. Uninstall clears them.
`contributes.hostLinks` (API 52): up to 4 of gugu's own pages where what your tools manage is shown, e.g.
`["library:prompts"]` for an App whose tools edit the person's prompts. The host page draws each as one entry, titled with
that page's own name; you write no text. Values: `library:prompts`, `library:agents`, `library:integrations`,
`library:mcp`, `library:themes`.
Switching the App off, withdrawing `agents:tools`, or uninstalling cancels pending calls (agent/page,
including startup), closes program IPC authority and stops its process tree. Other Apps are unaffected.
Single-call cancellation does not stop other sessions sharing the program. Upgrades/settings drain already-running
stdio calls; calls still starting may be interrupted.
A program's real failures reach the agent in its tool result and the person on the App's page; installed does not mean running.
`{"name","host"}` programs (`browser-use`, `computer-use`) only mark outdated versions of gugu's own Apps: Gugu no longer
hosts them, so such a version runs nothing and tells the person to update it from the App market. Write a stdio program instead.
A tab with `"widget": { "height": 240 }` (API26; integer 64–520) can also be sent with `widget_send`: read `guide_read widgets`.
Settings go in `settings`, which the host draws. If they need a page of their own, name its tab in `contributes.settingsTab` (API35): the App's settings page links to it.
If the App has other tabs, a task's + and the command list do not offer this one as a page.
It cannot also declare hostPage, perSession, opensFiles or chatFile. `ctx.widget` is present in a message and its hidden check:
`{ messageId, data, sender }`; from API33 also `id`, the widget's own identity (the same in its quotes), and `originMessageId`, with
`messageId` the message it is shown in. Data is untrusted, immutable input from any chat member; never execute it. Persist personal
state in App data and shared state in chat files. Every dispatch from a widget requires a gesture in that App, even with a target,
on both desktop and phones. Cloud and file calls retain their ordinary permission and gesture checks.
Normal App pages keep their existing behavior.
Check your sent card with `app_check { message_id: "msg:…" }` (or `widget_id` for its widget); the host infers its tab
and binds its original input. Steps are real operations as the calling agent; shared writes change what everyone sees,
while draft/display handoffs return in `shown` without touching the human composer. Deduplicate votes by
`ctx.operator.id`, and label agent votes as such. See guide `widgets` for sizes, unavailable cards and continued pages.
A tab with `"perSession": true` has one page in each session, never moved between them — two sessions side by side
each show their own (not with `opensFiles` or `"hostPage":"settings"`).
Use the existing `agents:tools` capability for programs/skills (see `apps-programs`).
Tool Apps run and are configured on Gugu Desktop. Phone package installs refuse host pages explicitly.
`app_check` drives custom HTML pages; open a host page with the `tab_kind` returned by `app_install`
or `app_search` and check its configuration and connection as a person would.
