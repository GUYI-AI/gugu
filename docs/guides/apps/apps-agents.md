# Seeing and driving agents from your page

These `window.gugu` verbs reach agents by consented scope, independent of page location: plain words reach agents you
started, `:all` everyone here, `:all-machines` other computers too. readAgentHistory stays local; sessions.index/read
can name a device. Other APIs: `apps-page`. Monitoring without an open page belongs in the background page.

Free — what the app is showing:

- `getAppState()` → what the APP is showing, as opposed to where you sit:
  `{ windowFocused, activeSessionId, activeProjectId, panes: [{ paneId, focused, activeTab: { tabId, kind, agentId?, filePath? } | null }] }`.
  `activeProjectId` is ungated. Walk `panes`: the workspace splits, so never assume `panes[0]` is focused.
  `focused` holds the keyboard; `kind` is open-ended (Apps register kinds), so ignore unknown ones.
  `agentId` needs `agents:read`, `filePath` needs `files:read`; absent means "not granted", not "not that sort of tab".
  `panes` says what is OPEN, not painted: a zero-width pane or a collapsed panel still lists its tab. For whether YOUR OWN
  surface is on screen read `getContext().layout.visible`; per-pane visibility is not exposed.
  The same answer wherever your page is: when `activeSessionId` is not your `context.workspace.sessionId` the
  person is elsewhere — your cue to stop animating and stop polling.
- `onAppStateChanged(fn)` → that state moved: a pane switched tabs, the view split, the person
  changed session, the window gained or lost the foreground. Identical states are not re-pushed,
  so this is not a poll in disguise.

Needs `agents:read` (or `agents:read:all` / `agents:read:all-machines`, which cover it):

- `listAgents()` → every agent you may see, as `{ agentId (user:<uuid>), sessionId, deviceId, deviceLabel, projectId, title,
  providerId, model, modelLabel (its name in the model menu; null: show model), transport, parentAgentId, spawnedByThisExtension, status, detail, isGenerating,
  lastStopReason, failure, lastActionAt, pendingPermissionCount, queuedPromptCount, contextTokens, rateLimit,
  updatedAt }`.
  `detail` refines `status`: `running` | `parked` (only background work); `approval` | `question` |
  `plan` | `dialog`; `done` (turn finished) | `plain` (stopped, exited); `null` for `error` or no status.
  `failure`: why a panel agent's engine went away by itself, `{ kind: 'adapter-exit' | 'start-failed', message,
  exitCode, signal }`, kept until it is started again; `null` while fine or stopped on purpose.
  `lastActionAt`: its newest tool call, however long ago (a dead engine keeps its last) — compare it with now.
  `contextTokens` is the context its engine last reported in use — what its next turn reads back.
  `rateLimit` is the account limit its engine last reported: `{ status: 'allowed' | 'allowed_warning' |
  'rejected', resetsAt, window, utilization }` — back off at a warning, resume after `resetsAt`.
- Scope comes from installation consent, never an argument: `agents:read` sees agents you started
  (`spawnedByThisExtension:true`); `:all` sees everyone here; `:all-machines` adds other online computers
  (`deviceId`/`deviceLabel`; `null` = here), with null live counters. Offline/old machines are absent from agent rows.
  Declare ONE word per capability family; the schema refuses two.
- `transport` is `'acp'` (a chat panel) or `'pty'` (a terminal). **Live counters are `null` unless that agent is
  open right now**: `isGenerating`, `pendingPermissionCount`, `queuedPromptCount`, `contextTokens`,
  `rateLimit` and `lastActionAt` are `null` for every terminal agent and for any panel agent not open now. `null` means
  "cannot be asked", NOT zero: a "0 waiting" badge drawn from a `null` is a lie.
- `pendingPermissionCount > 0` means the agent is waiting for a human.
- `onAgentsChanged(fn)` gives scoped local agent IDs for status changes; call `listAgents()` for details.
  It reports neither deletions nor remote changes, even with `:all-machines`; poll for those.
- `listAgents({ report: true })` → `{ agents, devices, unreached, checkedAt }`, same scope. Rows add `statusFrom`
  (`this_machine` / `device`) and ISO `statusAt` (observation time). `unreached`: `{ deviceId, label, detail }`;
  null deviceId means remote listing failed. Missing there is unknown, not deleted. Poll for remote changes.
  With `agents:read:all-machines`, `devices` is the host machine directory, including zero-task machines:
  `[{deviceId,label,online,thisMachine,checkedAt}]`. Other scopes receive `[]`. IDs are raw; call with `device:<id>`.
  `thisMachine` identifies this native host; always false on phones. The directory includes zero-task hosts.

Needs `agents:history` (or `agents:history:all`):

- `readAgentHistory(agentId, before?)` →
  `{ messages: [{ messageId, sender, text, turnId, seq, startedAt }], nextCursor }`,
  oldest turn first (newest last), capped per call. `nextCursor` is `null` once you reach the beginning;
  otherwise pass it back as `before` for the previous page.
- **Read from the record the agent's engine keeps** (claude, codex, opencode), as the session page shows it: terminal
  and closed agents too; other engines' agents only while open. Reading never opens an agent.
- `error.code`: `not-found` (not visible; worded as no such agent), `unavailable` (there, not readable now),
  `invalid` (a `before` that is no page's `nextCursor`).
- **`nextCursor` is the only end-of-conversation judge, not `messages.length`.** Paging is
  by turn, filtering is by message, so a page can come back empty while `nextCursor` is
  still set — those turns were all thinking and tool calls, nobody spoke. Keep paging until
  `nextCursor` is `null`.
- `text` is what was said; thinking and tool calls are deliberately left out (their shape changes for reasons
  that are not your tab's).
- Scope is its own: this capability does NOT ride on `agents:read`. An agent outside your
  scope is refused with the same sentence as one that does not exist, because whether it
  exists is itself something you were not granted.
- This is the person's conversation, including whatever they pasted into it. Read it because
  your tab needs it, not because you can.

Needs `agents:control` (or `agents:control:all` / `agents:control:all-machines`):

Phones: listAgents reads the computers' current lists (own / all-machines scope); live counters are null. Tells/drafts reach their agents. New agents use the context's computer, else the most recently online one;
the sheet lets the person change it. `agents:control` starts agents and tells those this App started; `:all-machines`
can tell any of the person's agents. A sheet pick needs no capability.

- Starting and telling an agent is `dispatch` (`to: { new: true }`, `{ agent }`): what `spawn` leaves out is what the
  person's new-session box would pick; to start one like an agent you see, pass its row's `providerId` (as
  `harness`), `model`, `transport`, `projectId` (as `project`). It stays in your scope (`spawnedByThisExtension`).
  `:all-machines` reaches your other computers too.
  API 17: `spawn.device:'device:<id>'` explicitly starts there, requiring `agents:control:all-machines`.
  The target computer chooses its defaults and records the agent as started by this App.
- `stopAgent(agentId)` → stops one you can see on this computer, panel or terminal. It does not undo the work
  already done.
- Starting an agent and a message to one **spend the person's quota**. There is no second prompt at
  call time: they agreed when they installed you. That is exactly why you should not loop.
- Anything you start is recorded as started by YOU, and stays marked that way even after the
  person uninstalls you.
