import { EXTENSION_API_VERSION, EXTENSION_TOOL_CONFINEMENT_API_VERSION } from './bridge-protocol';

/**
 * 交给 agent 的「怎么写一个 tab 扩展」简报。
 *
 * 为什么要有这东西:`gugu_session` 里 app_* 那几行索引很短,一个 agent 读完并不知道
 * `window.gugu` 存在,更不知道 manifest 能声明什么。它于是只会写出一张静态 HTML ——
 * 而验收要的是「高定制化能体现我们的简单可扩展」。缺的从来不是能力,是知识。
 *
 * ⚠️ 这份是**手写的散文**,不是从常量生成的:生成出来的清单能保证不漂,却讲不清
 * 「这个动词什么时候该用、代价是什么」,而那正是 agent 需要的部分。
 * ⇒ window.gugu 的每个动词、每条能力、app_* 每个工具都得在这里、写在对的「Needs」下 ——
 * 由 tests/unit/desktop/mcp/guguGuide6614.test.ts 对着源码判。
 *
 * 分成几篇,每篇不超过 GUIDE_TOPIC_BYTE_BUDGET(gugu-guide-tool.ts):Codex 把超长的工具输出按字节截掉
 * 中段,一整篇写在一起时 Codex 会话读到的是掐头去尾的两半(#6615 W-22)。
 *
 * 用英文:同目录的工具描述都是英文,而这份是同一个面上的东西。它不进任何人眼里的
 * 界面,所以不走 i18n。Refs #2374
 *
 * 集体记忆对账(L11 复核 61)第 6、7 条:
 * - App 进群只有一条路:`app_install` 带 `chat_id` 和 data —— 只有它顺带建数据文件、先检查再发卡(F15 / F40,
 *   acp-engine-utils 的 chat_id 那段)。`app_pack` 只在「只分享、不装」时出场(owner-no-compat-multi-paths、真源原则 12)。
 * - 从文件夹装过的重装、新版没多声明什么就直接替换不问(D-17,`installPlan` 的 asks);❌ 只写「声明了就等人点头」——
 *   迭代时 agent 会每次重装都去请人点同意。
 *   `apps` 这篇贴着字节上限(guguGuide6614):补的这半句,由第 5 步删掉的「Installing and testing your own App never
 *   needs it」抵掉 —— 开头那段已经说清装和进群各走哪条。
 * 第 4 条:`listAgents` 的 transport 和 `dispatch` 的 `spawn` / `session_spawn` 同一套词 `acp` / `pty`(真源原则 12),
 *   所以「照着一个 agent 起一个」能把 transport 原样传回去。
 */
/** Where the host-integration App APIs went (MCP surface review 11-16: 0 reads in 454 sessions): public docs, not guide_read. */
export const APP_REFERENCE_DOCS_URL = 'https://github.com/GUYI-AI/gugu/tree/dev/docs/guides/apps';

export const EXTENSION_GUIDE_START = `# Making a gugu App — start here

An App is something people open and use at once — in a chat's side panel or in a session: a vote,
a board, a form, a small game. When people have many things to act on together, an App beats asking
them one by one in chat. Installing puts it on your owner's computer; given a chat's \`chat_id\` and
data, it also goes in as a card the others install from. This page is enough for a chat App;
\`apps-files\` (the live file), \`apps-page\` (\`window.gugu\`), \`apps-ui\` (the look), \`apps-programs\`
(tools for agents) and \`apps-fork\` (changing an App) go further. Host integrations — bindings, the
assistant, projection, task pages, cloud, sessions, editors, settings pages, agents — are documented at
${APP_REFERENCE_DOCS_URL}.

## A chat App, end to end

When one of these tools is not in your tool list, it is in \`catalog_list\`.

1. \`app_create\` with \`template: "group-json"\`, \`id\`, \`name\` and your whole \`app.js\` in \`files\`: the
   template writes the page, opens the chat's \`.<id>.json\` file for it and shows offline and errors.
   \`app_create\`'s own description is the app.js skeleton: \`f.data\` is the file's JSON, live — read and
   write it as any object; several changes at once in \`f.transact(fn)\`. What many people add to (votes,
   cards) is a map keyed by id (\`f.data.votes[me] = choice\`), never an array index.
   \`html\`…\`\` is markup only: no \`@click\` / \`onclick=\${fn}\` — a function goes in as text. Listen once, by
   delegation: \`$('#shared').addEventListener('click', (e) => { const b = e.target.closest('[data-vote]'); if (b) f.data.votes[me] = b.dataset.vote })\`.
2. \`app_install\` with \`source_dir\`, \`chat_id\` and \`data\` (the starting JSON, or \`{item_id}\` of a file
   already in the chat): one call makes the data file, checks the App on it and posts its card.
3. \`app_check\` — runs a tab as a hidden page (a chat App: on its file, \`item_id\`) and reads back whether
   it loaded, its errors (a \`hint\` is advice), console, a snapshot and pictures. After every install:
   fix, reinstall and check until \`ok\` and it looks right; only then tell the person it is done.
4. \`app_search\` — what is installed now. \`app_pack\` — only to share it without installing it.

Other Apps — a page of your own, a tools-only App — are a folder: \`manifest.json\` plus its files, written by
\`app_create\` from \`manifest\` (manifest.json minus id, name and version) and \`files\` (path → text).

## manifest.json

\`\`\`json
{
  "id": "csv-lens", "name": "CSV Lens", "version": "1.0.0",  // id [a-z0-9-]+; version x.y.z
  "apiVersion": ${EXTENSION_API_VERSION},
  "platforms": ["desktop"],       // desktop, phone, or both
  "entry": "main.html",
  "background": { "entry": "background.html" },  // optional: one hidden page per App
  "permissions": { "capabilities": ["files:read"], "network": ["api.example.com"] },
  "contributes": {
    "tabs": [{ "name": "main", "title": "CSV", "opensFiles": { "session": [".csv"], "chat": [".md"] } }],
    "mcpServers": [{ "name": "rows", "command": "node", "args": ["mcp/server.js"] }],  // needs agents:tools
    "skills": "skills",            // <skill>/SKILL.md; needs agents:tools
    "instructions": "rows_query(file, sql) on any .csv"  // agents read it, <= 160
  }
}
\`\`\`

1-8 tabs. \`opensFiles\` is a claim (a suffix or a file name such as \`TODO.md\`), never a takeover: the
person's choice wins, and you are offered only where you declared. A page belongs to one place — one
session or one chat — for its whole life; the host keeps it alive, and \`onContextChanged\` brings what
changed. Opened for a file, its context's \`file\` is that file for good.

## Permissions: you may write them, you may not approve them

Capabilities: \`files:read[:all-machines]\`, \`files:write\`, \`chat:relay\`, \`chat:read\`, \`agents:read\`,
\`agents:history\`, \`agents:control\` (each with optional widenings), \`agents:tools\` (your MCP programs and
skills go to the agents on this computer) and \`notifications\`. \`files:write\` does NOT imply
\`files:read\`. \`network\` is bare hostnames (a leading \`*.\` is allowed). A bundle declaring nothing new
installs at once; otherwise the person confirms first — tell them what it asks for and why.

## The sandbox — walls, not guidelines

Own origin (\`gugu-ext://<id>/\`); no Node, no IPC, no new windows, no reach into the host or other tabs.
\`script-src 'self' 'wasm-unsafe-eval'\`: bundle your scripts (no CDN, no inline scripts, no \`eval\`).
Network is https/wss only, to declared hosts; localhost, \`*.local\` and IP literals are refused. A restart,
upgrade or revoked permission reloads the entry: keep real data in files.

## Look

Every page has gugu's look, light and dark: semantic HTML is styled already; no fonts, sizes, colours or
radii of your own; icons \`<gugu-icon>\`, people \`<gugu-avatar>\` (\`apps-ui\`).

## Several people at once

Ids of people and agents are \`user:<uuid>\`, as in MCP. \`f.presence.set(state)\` shares something
short-lived — a cursor, a game frame; never saved, the latest arrives. \`f.presence.others\`
(\`{ userId, name, color, state }\`) is everyone else with the file open; colour people with \`color\`.
A real-time game: each page moves its own player in its own presence and runs the rest locally; the file
keeps only what lasts — scores, the food, who won. ❌ No clock in the file and ❌ no host page stepping the
game for everyone. A game loop draws once per tick and reads presence there; do not also draw on
\`f.presence.onChange\`.

Secrets: everyone in the chat can read every file of it — scrambling hides nothing. A secret stays in
the page of whoever holds it (memory, or your App's own \`gugu.writeData\`). A game that needs a trusted
judge (werewolf): the judge is an agent whose owner does not play, and it tells each player their secret
privately; asking for a private answer, it tells them plainly to whisper it.
`;

export const EXTENSION_GUIDE_PAGE = `# window.gugu — the API your page calls

## Where your page runs

Location fills context, never changes authority: a task has \`session\`, a chat panel has \`chat\`, a file page has \`file\`;
the dock/background have neither chat nor session. Read context before drawing.
- \`gugu.files\`: open, list, create, rename, remove — the one way to open and edit a session's file. Name its target (\`apps-files\`).
- \`setTabTitle\` / \`setTabBadge\`: your tab/panel. \`reportError\`: there and in the App error log, read by \`app_check\`.
- \`openBrowserTab\`: a browser tab in a session; the system browser elsewhere (a phone: a new window).
- What a host cannot do is not on its \`gugu\` (\`typeof gugu.x\`): the background page and a program have no tab
  or gesture (no \`setTabTitle\`, \`dispatch\` without \`to\`, \`clipboard\`, picker); a phone has no background page, \`notify\`,
  programs (a session's tab calls its computer's), agents or working copies — no cookies: \`localStorage\` / IndexedDB or \`writeData\`.
- \`gugu.clipboard.writeText\`: click/key only, including your \`menu\` / \`toolbar\` entries (\`onCommand\`), drawn on the tab/panel header.
- Chat panels open at 520 px: design narrow first, widen with a media/container query.
- No \`alert\` / \`confirm\` / \`prompt\`: use \`gugu.modal\` below.

## Custom modals (apiVersion 11)

\`await gugu.modal.open({ entry: 'new.html', title: 'New card', size: 'md', data })\` opens your bundle's HTML in
gugu's window-level dialog (phone: fullscreen). Sizes: xs/sm/md/lg/xl. No new consent.
The page stays sandboxed with the opener's context/grants; \`(await gugu.getContext()).modal.data\` holds \`data\`.
Save, then \`gugu.modal.close(result)\`: the opener gets it, or null if cancelled.
The host handles Escape, Tab traversal, Back and focus restoration.

Free:

- \`getContext()\` → \`{ apiVersion, tabId?, chat?, session?, file?, modal?, operator, locale, themeMode, capabilities, layout? }\`.
  \`chat\`: \`{ id, name, kind: 'group' | 'dm', groupId, members? }\`; \`groupId\` is null in DMs. Topics use their source chat.
  API ≤26 includes \`members\`; API ≥27 omits it: call \`gugu.chats.members({ chat: ctx.chat.id })\` (\`chat:read\`).
  Members: \`{ id: 'user:<uuid>', name, kind: 'human' | 'agent', avatar? }\`; \`avatar\` is a \`data:\` image. Pick from these; never copy them into files.
  \`session\`: \`{ id, agentId?, projectId?, root?, deviceId?, deviceLabel? }\`; \`agentId\` is \`user:<uuid>\`.
  Local \`root\` needs \`files:*\`; remote sessions carry \`deviceId\` instead. \`file\`: open with \`files.open(ctx.file)\`.
  \`operator\`: \`{ kind: 'person', guguNumber? }\` (API 32: own 咕咕号; \`null\`: none/unread) or \`{ kind: 'agent', id }\`. \`capabilities\`: current grants, revocations applied.
- \`gugu.navigation.go(-1|1)\` → boolean; own history/chat opener. State: \`getContext().navigation\`.
- \`onContextChanged(fn)\` → theme, language, visibility and size changes; member changes only through API 26. Returns an unsubscribe.
- \`onCommand(fn)\` → the person picked one of your menu/toolbar entries: its id.
- \`showContextMenu({ x, y, items: [{ id, label, enabled?, checked?, danger?, title?, person?, items? }, { type: "separator" }] })\` (API 18/38, page) → id | null.
- \`setTabTitle(title)\` → title (max 48); file tabs use it as a tooltip. Back/forward stay local.
- \`setTabBadge(badge)\` → a count (99+ max, <=0 none), a string (a dot) or \`null\`.
- \`openBrowserTab(url)\` → http(s) only.
- \`reportError(message)\` → shown to the person. Never fail silently.
- \`sendToBackground(message)\` → your background page (none: rejects); host stamps \`from\`.
- \`onBackgroundMessage(fn)\` → paint the background's broadcasts.
- \`broadcastToViews(message)\` → background → live views, resolves \`{ delivered }\` (0 is normal).
- \`onViewMessage(fn)\` → background hears \`(message, from)\`; \`from\`: host-stamped sender context.

Handing something to someone (\`apiVersion\` 15):

- \`dispatch(text, { to?, draft?, refs?, images?, visible?, delivery?, key?, spawn?, offer? })\` → \`{ to, id?, deferred? }\` |
  \`{ cancelled: true }\`. \`to\`: \`{ chat, member }\` (a whisper as the operator; \`visible: true\`: the chat sees it),
  \`{ agent }\` (as \`session_message\`; \`delivery: 'queue' | 'defer'\`, \`key\` replaces your waiting one), \`{ new: true }\`
  (\`spawn\`: \`session_spawn\`'s words; answers \`{ to: { agent } }\`). \`draft: true\`: only into \`{ chat }\`'s / \`{ agent }\`'s
  composer (or \`refs\`' chat; \`images: [blob]\` a chat's) — they send it, or not.
- No \`to\` (a click or key): gugu's sheet shows the text (theirs to edit), the pills and whom — the chat's agents and people,
  their own agents, a new agent (\`offer\`: \`chat\` \`agent-in-chat\` \`person-in-chat\` \`my-agent\` \`new-agent\`); their press is the
  consent, no capability. Never a picker of your own.
- Naming \`to\` sends at once: \`{ chat, member }\` needs \`chat:relay\`, \`{ agent }\` / \`{ new }\` \`agents:control\`
  (\`apps-agents\` doc); a program or background page must name it. Tell only whom it concerns; keep state in the file.
  Phones reach computers' agents too.
  Refused: \`not-found\` (left, yourself, absent), \`failed\` (computer unread), \`denied\`, \`rate-limited\`
  (30/minute to a chat), \`invalid\`. Agents following changes: a tool (\`apps-programs\`), gugu stamps its caller.

Free, from a click or key (they read and write no data):

- \`showMessage(id)\` → its chat comes up, scrolled to it (a file's \`sourceMessageIds\`). \`not-found\`: not in its chat.
- \`showSession(id)\` → that session comes up, as a click on it in the task list (\`ctx.workspace.sessionId\`, a tool's
  \`call.session\`). \`not-found\`: not in that list. \`{ peek: true }\`: beside your page, left as it is.
- \`refs: [{ file, at?, label?, version? }]\`: pills to places in one chat's files, "file · \`label\`": \`file\` its
  entry or \`ctx.file\`; \`at\` where (\`{ slide: 3, shape: 12 }\`), back as the \`onLink\` \`query\`
  of the App a click opens it in; \`version\` picked on (else the entry's). Only with refs may \`text\` be empty.

Needs \`notifications\`:

- \`notify({ title, body?, tag?, data?, open? })\` → system banner under your App's name.
  Rejects when notifications are off. Max 10/min; reuse \`tag\` to update a banner.
  Only when the person must act; use \`setTabBadge\` for progress/completion.
  \`open\` is what a click opens: \`{ session, tab? }\` (your tab there), \`{ chat }\` (you, in its panel), \`{ file }\`
  (where it lives); none, your own page. Back to the tab that posted: \`open: { session: ctx.workspace.sessionId, tab: 'main' }\`.
- \`onNotificationClicked(fn)\` → \`{ tag?, data? }\`, your own values back. Delivered to the
  background page and to the page the click opened — even when that click is what opened it.

Free:

- \`linkTo(target)\` (API 13), desktop/phone/programs → a resource link: \`{ kind: 'chat', chat, message? }\`;
  \`{ kind: 'file', file, at?, version? }\` (chat file id/entry); \`{ kind: 'session', session }\`;
  \`{ kind: 'project', project }\`; \`{ kind: 'app', app?, tab?, path?, query?, chat?, session? }\`.
  App defaults: yourself, your first tab; at most one chat/session. Stored chat/file links are build-independent;
  \`external: true\` uses the build scheme for OS invocation (email/browser), as App/session/project links do. Never spell schemes.
- \`openLink(url)\` (API 13), desktop/phone → opens the resource, no capability. Page click/key required (including native \`<a>\` and \`gugu.markdown\`);
  programs/background pages only generate links.
- \`onLink(fn)\` → \`{ tab, path, query, file }\`: that link, a pill to your file (\`refs\`; \`file\`: id) or (API 7)
  a task chat's \`path#k=v\` link (\`file\`: path), also if it opens your page; phones too.

## Every one of these can reject — let it show

Show rejections inline, disable the control with its reason, or call \`reportError\`.
❌ Bare \`.catch(() => {})\` hides failures as empty states; intentional ignores need a comment explaining why.

❌ Top-level \`const gugu = window.gugu\` redeclares the host's global: SyntaxError, no script or error UI runs.
Use \`window.gugu.x\` or another name.
`;




export const EXTENSION_GUIDE_PROGRAMS = `# Giving agents your own tools

Programs/skills: \`apps-settings\` doc; pages: \`apps-page\`.

Needs \`agents:tools\`:

- Your tools, in plain JavaScript: \`"contributes": { "mcpServers": [{ "tools": "tools.js" }] }\`, and
  every export of \`tools.js\` is one tool. A card's followers, say:

\`\`\`js
export const follow = {
  description: 'Be told when a card on this board changes.',
  inputSchema: { type: 'object', required: ['board', 'card'], properties: {
    board: { type: 'string', format: 'gugu-file' }, card: { type: 'string' } } },
  async run({ board, card }, { agent }) {
    const f = await gugu.files.open({ id: board })
    if (!f.data.followers[card]) f.data.followers[card] = {}
    f.data.followers[card][agent] = true
    return 'following ' + card
  },
}
\`\`\`

  The page uses \`gugu.dispatch\` for followers when the card changes. gugu stamps \`agent\` (\`user:<uuid>\`),
  \`session\`, \`workspaceRoot\` (absolute) and \`model\`; unknown fields are absent. Never accept agent ids as arguments.
  Keep session for \`showSession\`; \`listAgents\` gives the same model.
  API 21: run receives non-enumerable \`signal\` (AbortSignal). Pass it to drivers; abort queued actions, never replay unknown results.
  Return human steps immediately; the agent asks via questions/messages, then retries.
  run returns a string verbatim or JSON; a throw is the agent's error. Non-tool exports stop the module and name it.
  Keep helpers unexported or in bundle imports; \`node_modules\` does not work. Built-ins follow the limits below.
- API ${EXTENSION_TOOL_CONFINEMENT_API_VERSION} tools read bundle/runtime/data; write only data (TMPDIR=data/.tmp).
  Files: gugu.files + files:read/write. Network: granted permissions.network hosts.
  No IPs/listeners/subprocesses/addons/WASI/inspector/sqlite/eval workers; bundle workers inherit limits.
  Not an OS sandbox. Older tools/commands retain full rights.
  Owners install for their agents; never store agent IDs.
- Another language, or an existing MCP server: \`{ "name", "command", "args"? }\`, MCP over stdio.
  \`command\` \`node\` runs on gugu's own runtime; \`./x\` is a program in your bundle; anything else
  is found on PATH (\`npx\`, \`uvx\`, \`python3\`). An argument naming a file in your bundle is passed
  as an absolute path; installation shows the command verbatim. Every reply, including errors, needs its request's
  \`id\`; omitting it fails all in-flight calls. Host-stamped \`_meta\`: \`gugu/agent\`, \`gugu/sessionId\`,
  \`gugu/conversation\` (its private chat), \`gugu/workspaceRoot\`, \`gugu/model\`, \`gugu/modelLabel\`,
  optional \`gugu/agentName\` / \`gugu/taskTitle\` (same task name). Task stop cancels that task's calls;
  honor the signal and finish input cleanup. Report progress on \`progressToken\` every 60 seconds or Claude aborts at 300.
- Either way the working directory is your bundle, with \`GUGU_EXTENSION_ID\` and
  \`GUGU_EXTENSION_DATA_DIR\` — the folder pages use via \`readData\`/\`writeData\`. One process serves all sessions;
  starts on use; open files and host resources prevent idle reclaim.
  A program on \`node\` has the global \`gugu\` — a page's, but for the page's own verbs; a \`worker_threads\`
  worker has none (relay through the main thread yourself). It opens a chat file it
  is handed by its id, \`{ id }\`, and \`gugu.dispatch(text, { to: { chat, member }, refs })\` whispers in that file's chat.
  A file it makes goes in with \`gugu.files.upload(place, file)\` (\`files:write\`) — into the chat of a file an agent
  handed it, as that agent, judged by the agent's membership; a stored file it is handed
  gets its next version with \`gugu.files.replace(file, blob, { expectedVersion: entry.version })\` (needed;
  \`content-changed\` if another write came first) — the agent's write, its old version kept
  (\`gugu.files.versions(file)\` lists them, \`gugu.files.readVersion(file, n)\` reads one).
- A parameter \`{ "type": "string", "format": "gugu-file" }\` is a chat file the agent hands you:
  gugu checks the agent can open it, and for that call your program opens it with no capability, as that
  agent — even in a chat the person is not in — and what the program writes is the agent's. No
  presence, and nothing that needs a person's click.
- A parameter \`{ "type": "string", "format": "gugu-chat" }\` is a chat the agent hands you — its id, or the
  number people see (you get the id). gugu checks the agent is in it; for that call what your program lists,
  makes, uploads, renames and removes there is the agent's, by its membership (\`files:read\` / \`:write\` still).
  There, name a file by its entry or \`{ chat, id }\`: a bare \`{ id }\` not handed itself is \`denied\`.
  \`format\` counts on a tool's own parameters (or a string array's items), never inside an object.
  A verb a call's own code makes is its agent's, even with two agents' calls on one file or chat. When the call
  ends, what it opened as the agent closes once that agent has no other call running. Any other chat or file is
  \`denied\` in a call, and after it ends (a timer it set) — never the person's. Made in no call (\`onChanged\`, a timer
  set before): the person's, by \`files:*\`. Await what must be the agent's. A batched write is its call's.
- Doing to a file what an agent does: a JSON file's \`f.text\` is what the agent reads (indented two spaces), and
  \`f.edit(old, new)\` changes it as a text file's does (it must stay an object). \`files.create\` and
  \`files.upload\` take \`{ sourceMessageIds }\`: the messages the file came from. Codex keeps about 12 KB of an answer:
  keep each under 8 KB, page the rest.
- \`contributes.skills\`: a folder of Agent Skills (\`<skill>/SKILL.md\`), given to the agents your
  tools are given to. A session that opens with you there has them from its start (Claude Code and Codex
  list them as skills, other agents get a line naming each SKILL.md); one that opened before
  you were installed finds them in \`catalog_list\`.
- Agents reach your tools through the catalog (\`catalog_list\` / \`catalog_call\`), named
  \`<App id>__<tool>\` whichever program gives it, in every session the moment you are installed; the person can have them
  listed natively instead, from the next session on. \`contributes.toolsListed: true\` asks for that at the first install
  (the person can switch it back). Withdrawing \`agents:tools\` refuses further calls; lifecycle: \`apps-settings\` doc.

Free — your own programs and data folder:


- \`callProgram(tool, args?, { server?, device? })\` → your MCP tool's \`{ content, structuredContent?, isError? }\`.
  \`_meta.ui.visibility\` must include \`"app"\` (absent: both); \`["model"]\` hides it from pages, \`["app"]\` from agents.
  \`server\` selects one of several (a server string also works); API 17 \`device:'device:<id>'\` chooses a computer without a task.
  Stamped \`"gugu/caller": "app"\`, the tab's session and its working copy, and on a page an agent
  works its \`"gugu/agent"\`. Refused while \`agents:tools\` is off.
  A tab of a session on another computer (\`ctx.workspace.deviceId\`) runs it THERE:
  \`not-installed\`, \`version-mismatch\`, \`unavailable\` (offline, too old, or silent 75 s: it may have run);
  1 MB each way (\`too-large\`).
- \`onProgramNotification(fn)\` → \`{ server, method, params? }\`: a notification your program sent
  while running (it starts on first call, stops after 5 idle minutes). A \`tools.js\` call that answered
  sends \`tools/called\` \`{ tool }\` itself; any other program, send one after the work.
- \`readData(path)\` → string, or \`null\` when absent. \`writeData(path, content)\` (atomic). \`listData(dir)\`.
  8 MB a file (1 MB in another computer's session's tab). Your program's folder: THERE
  in such a tab, a background page's here (\`localStorage\`: only this screen's). Your program announces
  changes, not the folder. Removed when you are uninstalled.
  A save needs no file; say one that fails:

\`\`\`js
let state = JSON.parse((await gugu.readData('save.json')) ?? 'null') ?? { score: 0 }
const save = () => gugu.writeData('save.json', JSON.stringify(state))
  .catch((e) => gugu.reportError(\`Could not save: \${e.message}\`))
\`\`\`
`;


export const EXTENSION_GUIDE_FILES = `# gugu.files — shared live files

Claim a file's name/suffix and open it live; don't bundle data (\`app_install\` data \`{item_id}\`).
Top-level await needs \`<script type="module">\`.

## App data

A tab's exact \`chatFile\` is hidden App state (\`entry.appState\`); APIs/agents/links still reach it.
Suffix claims are visible documents. \`gugu.files.viewPreferences({chat}, {showAppData:true})\` sets the person's
source-chat preference; omit options to read it.

## Which files you may open

Topic file addresses resolve to their source chat; messages keep the topic's.

Each call names a file: an entry, \`ctx.file\`, or \`{ chat | workspace, name }\`; or a place:
\`{ chat: ctx.chat.id }\` / \`{ workspace: ctx.workspace.id }\`. A session tab has both.
\`gugu.projects.list()\` → \`{ projects: [{ id, name, workspace }] }\`.

- \`ctx.file\`: no capability. The host picked your claim (\`opensFiles\`, e.g. \`{"chat":[".vote.json"]}\`, most
  specific wins) or "open with". Session claims: \`"session"\`.
- \`"chatFile": "x.board.json"\` (API 14): in chat, \`ctx.file\` is this top-level file, initially \`{}\`: fill it.
- \`"sideWidth": 480\` (API 16): chat-side tab width in px; default: half.
- A name claims one file (\`"session":["TODO.md"]\`); suffixes: your own format. Preserve unknown data.
  Changing course, remove your topics/files or ask. Session files in search-skipped folders hear disk changes on write only.
- Any other file (a chat you are in, a folder here): \`files:write\`, or \`files:read\` (read-only).
- \`gugu.files.list(place)\`: \`files:read\`; \`gugu.files.create({...place,name},content)\`, \`gugu.files.rename(entry,name)\`,
  \`gugu.files.remove(entry)\`: \`files:write\`. JSON: objects, not \`JSON.stringify\` strings.
- \`gugu.files.search({ query, suffixes, limit })\` (\`files:read\`): path search across the reader's chats, with
  \`chatName\`. \`gugu.files.recent({ limit })\`: last opened (\`openedAt\`).
- A chat's subfolders: \`gugu.files.list({ chat, folder })\` lists one (path or id, \`''\` the top; none: all;
  \`'folder'\` entries: list only);
  create and upload take \`folder\` too (made if missing); \`gugu.files.mkdir({ chat, path })\`,
  \`gugu.files.move(entry, { folder, name })\`; remove takes a whole folder. A name the folder has (any case):
  a new file gets \` (2)\`, a rename or move is \`name-taken\`. 「附件」 (\`systemRole\`) stays put.
  \`files.create(place, content, { ifExists: 'use' })\` (API 39): the existing one instead (two at once: one file).
- A session's working copy: \`apps-working-copy\` doc.
- \`gugu.files.onChanged(place, fn)\` → unsubscribe. Chat: \`{ kind: 'entries', entries, gone }\`.
- \`gugu.files.openWith(entry)\`: claim or "always use"; \`{ ask: true }\`: pick among all.
  \`intent\`: \`'navigate'\` (default), \`'newTab'\` (double-click), \`'beside'\`.
  \`{ at }\`: opener's \`link\` place. Unclaimed: preview, or details/download. \`{ peek: true }\`: beside this page
  (always for project files). Gone/unreadable: \`not-found\`.
- \`gugu.files.openWith(entry, { tab: 'explore' })\`: your own tab claiming it in \`opensFiles.chat\`; no picker.
  \`at\`/\`peek\` work; a bad tab, \`ask\` or workspace: \`invalid\`. Old hosts ignore \`tab\`.
- \`gugu.files.upload(place)\` (\`files:write\`, a click or key) opens the picker → the new entries (\`[]\`);
  a File: uploaded (≤ 25 MB, else \`too-large\`). \`gugu.files.download(entry)\` (a click or key) asks where
  to save → \`true\` saved; \`gugu.files.forward(entry|[…])\`: the forward page (working copy ≤ 512 MiB, else \`too-large\`).
- \`gugu.files.pick({ chat }, { suffixes?, multiple?, upload? })\` (62, click/key, no capability): the host's
  file sheet → the picks (\`[]\`), open to this page as \`ctx.file\`; \`upload\` + \`files:write\`: from this device too.
- Media opens read-only: \`URL.createObjectURL(await f.blob())\`; \`files.replace(entry,
  blob, { expectedVersion: entry.version })\` makes its next version (needed; else \`content-changed\`).
  \`files.versions(entry)\` / \`files.readVersion(entry, n)\`: its history.
- Entry: \`{id,chat|workspace,name,savedName,contentType,type,parentId,path,systemRole,size,version,
  createdAt,updatedAt,createdBy,updatedBy,sourceMessageIds,metadata}\`. \`gugu.files.canDelete(entry|[…])\` → [bool], for menus and batch deletes.
  23: \`savedName\`: save name. Authors: \`{id,name,kind:human|agent|system}\` or null.
- API 19: \`keep: {expiresAt,mine}|null\`; \`gugu.files.keep(entry, 'temporary'|'permanent')\`; 20: [], as download.
- Entries/versions: optional \`availability: available|expired|deleted|unavailable\`, \`expiredAt: ISO|null\`; offline devices stay available.

## Every opened handle

\`await gugu.files.open(entry)\` returns readable content with \`entry\`, \`type\` (text/json/binary),
\`readOnly\`, \`size: number|null\`, \`f.bytes(): Promise<Uint8Array>\`, \`f.blob(): Promise<Blob>\`, \`f.close()\`.
Document bytes are current UTF-8; JSON uses \`JSON.stringify(root, null, 2)\`. Only text/JSON have \`text\`;
branch on \`type\` or use \`f.bytes()\`, never poll for text.

Stored binary or text >1 MiB shares working-copy \`f.read(offset,length)\`: host packets ≤512 KiB;
\`f.bytes()\`/\`f.blob()\` read all. Chat ranges pin \`entry.version\`; unavailable old bytes throw \`stale-version\`
(reopen for current), never mix revisions. \`await f.close()\`, page removal or five idle minutes release the
snapshot. Remote working-copy size stays null until a range answers. Small stored text and \`readVersion\`
read whole; beside-document/download/forward stay unchanged. Cross-machine workspace replies retain base64.

## A text file (markdown)

Its handle — \`f.text\`, \`f.edit(old, new)\`, anchors — and an editor bound to it: \`apps-editors\` doc.

## A JSON file

Use \`f.presence\` (\`apps\`) for motion, the file for results, tools (\`apps-programs\`) for agent
instructions. Migrate old data when its shape changes; raise your format's version. File id: \`f.entry.id\`.

\`f.data\` is live: read/write/spread it. Assigning an object merges keys: listed keys recurse; keys seen but
omitted are removed; unseen concurrent additions survive, including with \`= {}\`. Concurrent plain values:
last write wins. Key collections by id (\`f.data.cards[crypto.randomUUID()] = {title,column}\`); sort only for display.
\`f.toJSON()\` makes a plain copy; \`structuredClone\` on it throws. Change by id/content, never an old index.
\`f.transact(() => …)\` groups a frame's writes.

Collaborative text: \`f.data.title = gugu.text('')\` (agent JSON: \`{"$text":""}\`). It reads as a string;
string assignment merges letters. \`f.textAt(['title'])\` returns a text handle for
\`gugu.bind.text(input, …)\`; plain strings remain single values and refuse textAt.
Per-person data keys: \`f.presence.self.userId\` (server-stamped \`user:<uuid>\`, \`self.name\`). Do not ask who they
are or invent locks/"being edited" fields: use presence.

Render others' text with \`textContent\` or \`render\` with html\`…\` (interpolations escaped), never raw innerHTML.
On changes, \`render\` patches by \`data-key\` and preserves focused inputs/IME. Keep unsubmitted drafts and
\`gugu.bind.text\` controls outside the rerendered area. Replacing innerHTML/children loses drafts/carets.
Link another file with its entry id and \`gugu.files.openWith(entry)\`; a name alone is not a link.

## When things go wrong

\`f.status\` is \`online\`, \`offline\` (keep editing: it is sent when back; also after 10 s without an answer —
it reconnects itself) or \`gone\` (deleted, you left the chat, a permission taken back: say so and grey it out; a
session's file put back on disk comes back \`online\`). \`f.onStatus(fn)\` fires when it or \`f.saved\` moves. Each
\`gugu.files.open(…)\` is its own handle; \`f.close()\` lets it and its handlers go.
\`f.onRefused(({ reason }) => …)\`: \`too-large\` — your change was undone, tell the person;
\`rate-limited\` — it will retry by itself. \`f.saved\` is true once the server has everything.
Every failure is an Error with a \`code\`: \`denied\`, \`not-found\`, \`ambiguous\`, \`read-only\`,
\`content-changed\`, \`name-taken\`, \`invalid\`, \`failed\`; \`file-unavailable\` when \`gugu.files.open\` had no answer in 10 s.
`;











export const EXTENSION_GUIDE_UI = `# How an App page looks — gugu's look is there already

Every App page gets gugu's own look before its first line: a stylesheet, all of it in \`@layer gugu\` (the lowest, so
anything you write wins — no \`!important\`), and four elements of the host. Plain semantic HTML looks like gugu, in
light and dark, in a chat's shared side panel (520 px), on a phone (412, touch sizes) and full screen. The
picture below this text is every piece, each captioned with the markup that draws it.

## Four rules

1. Write semantic HTML: it is styled already.
2. Set no fonts, font sizes, colours or corner radii. Drawing something of your own (a board, a chart): only the tokens below.
3. Icons are \`<gugu-icon name="…">\`, people are \`<gugu-avatar user="…">\` — never an emoji, an initial or a coloured box.
4. Read \`gugu.getContext()\` first: \`chat\` is the source group or private chat the page is open in. Read its people with \`gugu.chats.members({ chat: ctx.chat.id })\` (declare \`chat:read\`). Default to that chat; never make the person pick it.

## Elements — one line each

- \`h1\`–\`h3\` titles (a step smaller in a narrow panel), \`h5\` a section label; \`p\`, \`a\`, \`strong\`, \`small\` (times, counts), \`code\`, \`kbd\`, \`blockquote\`, \`hr\`, \`pre\`.
- \`button\`, \`button.primary\` (the one main action), \`button.danger\`, \`disabled\`. An icon alone: a \`button\` with \`aria-label="Refresh"\` and one \`<gugu-icon name="refresh">\` in it.
- \`<label>Name <input></label>\` (the label above it), \`select\`, \`textarea\`, \`input[type=search]\`; \`aria-invalid="true"\` marks a wrong one.
- \`<label><input type="checkbox"> Anonymous</label>\`, radios, a switch \`<input type="checkbox" role="switch">\`; \`fieldset\` + \`legend\` group them.
- \`<ul class="list">\` rows: \`<li><gugu-avatar user="…"></gugu-avatar><div><strong>Title</strong><span>subtitle</span></div><gugu-time datetime="…"></gugu-time></li>\`. A row is clickable as a \`button\` / \`a\` / \`label\` or with \`tabindex\`; \`aria-selected="true"\` marks the selected one. A plain \`ul\` / \`ol\` is a list in text.
- \`table\` (\`thead\`, a \`tfoot\` total), \`details\` + \`summary\`, \`progress\` (a vote's bar), \`meter\`.
- Tabs: \`div[role=tablist]\` of \`button[role=tab]\`, \`aria-selected="true"\` on the open one; \`role="status"\` a quiet note, \`role="alert"\` an error; a \`<dialog>\` (opened with its showModal) to confirm.
- Classes: \`.card\` a block, \`.row\` side by side (wraps), \`.stack\` a column, \`.muted\` secondary text, \`.primary\`, \`.danger\`. Nothing else is needed.

## The host's elements

- \`<gugu-icon name="bell">\` (\`size="md|lg"\`): gugu's icons, named as lucide names them — bell, users, search, settings, plus, x, check, pin, trash-2, chevron-right, refresh, ellipsis… \`customElements.get('gugu-icon').names\` lists them all; a wrong name comes back from \`app_check\` as a hint naming the close ones. \`label="…"\` when it alone says something.
- \`<gugu-avatar user="user:…">\` (\`size="xs|sm|md|lg"\`, \`name\` to show the name): a member of this chat, with their face. From API 27, declare \`chat:read\`; the elements share one member read per chat. Someone not in it: \`label="their name"\`.
- \`<gugu-time datetime="…">\` (ISO or ms): 刚刚 / 3 分钟前 / 08:20 / 昨天 14:20 / 10月3日, kept current, in the person's language.
- \`<gugu-empty icon="checklist"><strong>No votes yet</strong><small>Start one</small></gugu-empty>\`, with a \`button.primary\` last in it when there is something to do.
- \`<gugu-file-mark name="a.pdf" tile>\` (API 56): a file as gugu draws it.

## Markdown

Text written in markdown (a file, a message, a README): render it with gugu's own renderer — the dialect, look and
link rules of every gugu surface (math, tables, task lists, footnotes, coloured code, mermaid). Ship no markdown library.
(\`gugu.codemirror()\`'s \`markdown\` is CodeMirror's language, for editing the source; \`gugu.markdown()\` draws it.)

\`\`\`js
const md = await gugu.markdown()
md.render(element, text)   // replaces what element held; call again when the text changes
md.render(element, f.text, { density: 'comfortable', frontmatter: true, file: f.entry })   // a file to read
\`\`\`

\`density\`: \`'compact'\` (the default, a chat's rhythm) or \`'comfortable'\` (a document). \`frontmatter: true\` shows a
file's leading \`---\` YAML block as code instead of reading it as text. \`sourceLines: true\` marks each block with the
lines it was written on (\`data-line="3-5"\`), to find a line's block. \`trust: 'chat'\` (the default) is for others'
words: raw HTML stays text; \`'document'\` only for text your App wrote. Links: \`#…\` in place,
http(s) a browser tab, gugu resources through \`openLink\` (API 13, no capability), relative files beside \`file\`
through \`gugu.files.openWith\` (needs \`files:read\`). Failures call \`reportError\`. Never put others' text through \`innerHTML\`.
Images: a chat file's (\`gugu-file://\`, a path beside \`file\`) are drawn, web ones stay links; one pasted
into \`bind.codemirror\` uploads beside it.

## Drawing your own

A canvas, a board, an editor: write your own CSS, and take the values from the tokens — they follow light and dark by
themselves. Colours: \`--em-background\`, \`--em-background-1\` (a card), \`--em-background-3\`, \`--em-foreground\`,
\`--em-foreground-muted\`, \`--em-foreground-passive\`, \`--em-border\`, \`--em-border-1\`, \`--em-accent-9\` /
\`--em-accent-contrast\` (gugu's primary is ink, not a hue), \`--em-foreground-destructive|success|warning|info\` (text) and their
\`--em-background-*\`, \`--em-danger-solid\` (fill under a white label), \`--em-danger\` / \`--em-warn\` (fills with nothing on them; the foregrounds are for text), \`--em-hover\` / \`--em-press\` / \`--em-selected\`. Sizes: \`--em-font-caption|body|title|heading|page\`
(11–20) with \`--em-lh-*\`, \`--em-spacing-xs\`…\`-2xl\` (4–24), \`--em-radius-control\` (8) / \`-xl\` (12), \`--em-control-h-md\`.
The page's edge is \`body\`'s margin: \`body { margin: 0 }\` and the page is yours edge to edge.

## See it, and try it

\`app_check\` sends back pictures of your page where it opens (a group's panel is 520 wide, a session's tab its
pane), and 412 wide if it goes on phones, light and dark, and \`snapshot\`: the page as its accessibility tree outlines
it, a line per control (\`- button "New vote"\`). Look at them and fix until they look right; only then tell the person
it is done.

Try it as a person would with \`steps\`: \`{"click":{"role":"button","name":"New vote"}}\`,
\`{"fill":{"role":"textbox","name":"Title"},"text":"Friday"}\`, \`{"press":"Enter"}\`, \`{"waitFor":{"text":"Friday"}}\`,
\`"look": true\` for a picture. The page stays as they left it: give the answer's \`page\` back to go on there. A step
finds a control by role and name as the snapshot says them, so:
- an icon alone has \`aria-label\` (above);
- a button on every card or row: name the card — \`<article aria-labelledby="t3"><h3 id="t3">\` — and the step says
  \`"within": {"role":"article","name":"…"}\`;
- a control you draw (an svg node): \`role="button"\`, \`aria-label\`, \`tabindex="0"\`.

## On the market

On this computer an App needs none of this. To list it, add to manifest.json \`subtitle\` (<= 30 chars, one line
under the name; per language in \`localized\`, with \`tabs.<tab>.title\` / \`toolbar.<id>\`), \`defaultLocale\`, \`engines\` (\`{ "gugu": ">=x.y.z" }\`, the oldest gugu it
runs on — the market picks the newest version each machine can run), and beside it a \`store/\` folder, which is never
packed into the App:
- \`store/about.md\` — the product page's 关于, plain text, no images; \`store/about.<tag>.md\` for each \`localized\` tag.
- \`store/screenshots/*.png|jpg\` — 1-8, <= 1 MiB each, in file-name order, no captions.
- \`store/whats-new.md\` — what this version changed, no version number in it.
Also from manifest.json: \`icon\` (PNG, ❌ SVG), \`author\` (shown, not verified), \`categories\` (1-4 slugs; sections are
\`research\`, \`productivity\`, \`developer\`, else 其他), \`homepage\` / \`repository\` (https), \`license\`, and \`examples\`
(1-3 things to say to an agent with it, <= 80 chars, also under \`localized\`; a click starts a task with one).
`;


export const EXTENSION_GUIDE_FORK = `# Change an existing App — a fork

When a person asks an App to do something it does not support, or its own code has a bug,
offer to fork a version for them. Ask before starting: "This App does not support that yet.
Shall I fork a version for you?" Do not work around its missing feature with shell commands,
edit its installed files, or build a substitute. Check its tools and app_search first; a missing
feature need not produce an error. A fork cannot fix environment problems such as network,
login, missing permission, a stopped program or an offline device: do not offer one for those.
A tool saying it does not support an operation describes the current App, not whether its
code can be changed. Offer the fork before declaring the requested feature impossible or
proposing another tool. Investigate feasibility in the fork after agreement; do not promise
that a fork can add host capabilities which are unavailable.
Ask once; if they decline, do not ask again.

A fork is another variant of the SAME App. Only one variant runs on this computer at a time.
Data, chat enablement and already granted permissions belong to the App, so switching code
keeps them. A variant asking for additional permissions still needs the person's consent.
Never change the manifest id or break the existing data format. Do not clear, replace or
migrate their data to make your new code work.

## After the person agrees

1. Call \`app_create {fork_of:"<app-id>", name:"remote-watch"}\`. The variant name is an ASCII
   slug matching \`^[a-z0-9][a-z0-9-]{0,62}$\`. It checks out the exact
   installed upstream commit into a git working directory and returns where to edit. Use
   that returned directory, never the installed bundle. The upstream remote is \`upstream\`.
   A connected GitHub account gets a real fork as \`origin\`; without one, the local repo works.
2. Read the App's code and the relevant \`apps-*\` guides. Make the requested change in that
   working directory with your normal editing tools. Preserve data and the App's identity;
   keep its upstream version, and commit your code. Do not add permissions unless needed.
3. Call \`app_install {source_dir:"<returned-source-directory>"}\`: the host recognizes the
   fork, installs it as a variant and makes it active. Explain any new permissions; only the
   person can approve them in the existing consent panel. A refusal leaves it uninstalled.
4. Call \`app_check\` with the returned \`tab_kind\` (and \`item_id\` for a chat file). Exercise
   the requested feature using the App's actual tools or page, and verify the person's
   existing data is still there. Fix, reinstall and check until it works; then report the
   active variant and what changed. Do not call it done from an install result alone.

## Switch variants

\`app_install {market:"<app-id>", variant:"<name>"}\` selects an installed variant.
\`variant:"upstream"\` returns to the original. The person can also select a variant on the
App's detail page. No fork or data copying is needed to switch.

## An App resource URL

A link like \`<scheme>://app/<id>?device=<device-id>&variant=<slug>\` names that
installed fork on that registered device. Use \`app_manage\` with \`{url}\` to read its metadata,
source directory, base and upstream status; never look up a local namesake or pack its cache.
\`app_manage {url, operation:"switch"}\` activates it. \`operation:"remove"\` asks the
person, switches an active fork to upstream, then deletes only its registration and cache.
Original, App data, source Git directory, identity, settings and grants remain. Do not use
uninstall to remove one fork. Opening the URL only locates its detail, without switching.

## Bring in an upstream update

The App's row shows the upstream version and how many releases the active fork is behind.
Pin the target to that upstream version's published commit.
Read that repo's status first; preserve uncommitted work. Fetch \`upstream\` and merge the
specified commit with git's three-way merge, resolving conflicts in the fork. Before merging,
find its merge-base with the fork's HEAD and read the fork's diff from that base. List the
custom behaviors and stored fields it added; record the existing data's IDs and values.
After resolving conflicts, compare against both parents and verify each custom behavior and
old data format still works, including when a device is offline. Similar upstream code is
not proof that the fork's behavior was preserved. Do not replace
your fork's files with a fresh upstream bundle or merge a moving branch tip in place of that
commit. Keep the same data format, commit, then app_install the source directory and app_check
again. Read back the same data IDs and values and exercise the custom behaviors: app_check's
ok or an empty page is not proof that data survived. Missing data is a failed merge, not done.
A conflict or failed check is work
to finish, not grounds to silently discard the person's changes.

## Push or contribute, when asked

If the local repo has no \`origin\`, connect the person's GitHub account or use their gh CLI
to fork the upstream repo; add their fork as \`origin\`. Push the variant branch there. Do
not push to upstream. For a contribution, open a PR from that branch to upstream's default
branch, describing the change and actual checks. First-party Apps share gugu-apps: only change
\`sources/<app-id>\`, and target its \`main\` branch. Other Apps use their own upstream repo.
Pushing, opening a PR and merging upstream are requests the person makes to you, not actions
to take merely because you created a local fork.
`;

/** The App guides \`guide_read\` serves, one topic each — see GUIDE_TOPIC_BYTE_BUDGET in gugu-guide-tool.ts. */
export const EXTENSION_GUIDE_TOPICS: readonly { topic: string; about: string; text: string; picture?: 'look' }[] = [
  {
    topic: 'apps',
    about: 'Start here when people in a chat want something to use together — a game, a vote, a board, a form, a small tool: a chat App end to end (app_create group-json, check, install), several people at once, secrets.',
    text: EXTENSION_GUIDE_START,
  },
  {
    topic: 'apps-files',
    about: 'gugu.files: a chat\'s files, and a session\'s working copy — edited live by several people and agents together: text, live JSON, errors.',
    text: EXTENSION_GUIDE_FILES,
  },
  {
    topic: 'apps-page',
    about: 'The window.gugu API a page calls, the same wherever it runs: context, tabs, the background page, messages, notifications, links — and what each host (desktop, phone, program) has.',
    text: EXTENSION_GUIDE_PAGE,
  },
  {
    topic: 'apps-ui',
    about: 'How a page looks: semantic HTML, <gugu-icon>, <gugu-avatar>, <gugu-time>, <gugu-empty>, with a picture; app_check\'s snapshot and steps; the App on the market.',
    text: EXTENSION_GUIDE_UI,
    picture: 'look',
  },
  {
    topic: 'apps-programs',
    about: 'Giving agents your own tools (tools.js, MCP programs, skills), following what happens in your App, calling your program from a tab.',
    text: EXTENSION_GUIDE_PROGRAMS,
  },
  {
    topic: 'apps-fork',
    about: 'An App cannot do what the person asks, or has a bug: offer a fork, then change, install and switch variants while keeping data; merge upstream or contribute when asked.',
    text: EXTENSION_GUIDE_FORK,
  },
];
