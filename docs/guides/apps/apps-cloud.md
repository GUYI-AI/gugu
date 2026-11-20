# gugu.cloud — your App's own part of the cloud

For an App with its own tables behind `public.<App id>_*` functions (`-` in the id is `_`), reached as the person signed in
(manifest `apiVersion` 31; `typeof gugu.cloud` tells an older gugu). No capability. Only an App installed from the market
has it: a folder, a chat's bundle or a fork is `denied`, since any of them could name itself anything. Any other function
or topic is `denied`. Who may see and do what is the database's; a refusal's `error.message` is its reason word: say it in
your own words.

Free:

- `gugu.cloud.read(name, args?)` → what the function returns. Over GET, so it cannot write; it must be STABLE or IMMUTABLE.
  An argument null or absent is the function's default. Pages, the background page and programs.
- `gugu.cloud.write(name, args?)`: on a page, inside the person's click; on a page an agent works it is not done and answers
  `null`. In a program, for the agent the call is stamped with (`apps-programs`): pass that `agent` to the function, never one
  from the arguments. What moves something of the person's: draw your own confirmation first.
- `gugu.cloud.on(topic, event, fn)` → unsubscribe. A page's, on `gugu:<App id>:…` (the database broadcasts; a policy on
  `realtime.messages` says who hears). `fn` gets `{ payload }`, or `{ subscribed: true }` each time it is (re)subscribed: read
  again then, since a broadcast missed while away is not kept. ❌ Poll.
- `pickAgent({ title, subject, body, action, search, empty, preselect?, write? })`: from a click, gugu's sheet in your words offers
  the person's own agents (no capability: you never list them); → `{ agent, written? }` | `{ cancelled: true }`. Their press was in the
  sheet, not your page, so `write: { name, args, agent }` goes with the ask: that press does `cloud.write(name, { ...args, [agent]: <bare id> })`.
  API 60 `include`: `'agents'` (default) as above; `'people'` the agents and people of the chat the page is in; `'all'` both. A person
  picked → `{ member }` (`user:` id), an agent (yours or the chat's) → `{ agent }`. ❌ Your own member `<select>`.

Your agents, woken from the cloud (`agent.deliver` with `source` = your App's id): a `tools.js` (`apps-programs`) that exports
`inbox_pull({ agent })` → `[{ key, seq, actor_user_id, actor_name, actor_is_agent, created_at, ref, context, arrival, content }]`,
`inbox_ack({ agent, key, seq })` and `inbox_failed({ agent, key?, command?, state, error })`, each
`_meta: { ui: { visibility: ['app'] } }`, is asked what to hand an agent then and on later pulls. `arrival` says how to answer: your
tools by their full name. Not installed, off or without `agents:tools` on that computer: the owner sees it on the agent's task page
only (no chat to say it in), and retries once it is there.
