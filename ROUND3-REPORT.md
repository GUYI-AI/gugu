# #3283 round 3: one read path per kind of data

Head: see the final message (merges dev 7db4b05f6). Per-lane tables with the file of every path:
`tools/paths-1.md` (Apps / market), `paths-2.md` (agents, connections, team, automations), `paths-3.md` (assistant panel,
cloud computer, devices, phone, settings), `paths-4.md` (sessions, chat, git, search, files).

Counting rule: a replica plus its readers is one path. A component calling the source beside the replica, a module Map,
an effect+state read, or a store keeping its own copy is another path. A read inside a one-off command (a write, an
action's own answer) is not a read path; each such skip is named in the table notes.

## Read paths per data kind (dev a62bb6b35 → head)

| domain | data kinds | dev paths | head paths | kinds still on 2+ paths |
|---|---|---|---|---|
| Apps / market (lane 1) | 25 | 45 | 25 | 0 |
| agents, connections, team, automations (lane 2) | 39 | 52 | 43 | 4 |
| assistant panel, cloud, devices, phone, settings (lane 3) | 43 | 100 | 74 | 12 real (+5 rows that group several kinds, one path each) |
| sessions, chat, git, search, files (lane 4) | 26 | 34 | 25 | 1 |
| **total** | **133** | **231** | **167** | **17** |

(Lane 2's own report said 48 kinds 61 → 52 counting sub-kinds; the table file has 39 rows, 52 → 43. The totals above
use the table files.)

## What stays on more than one path, and why

| data | head paths | why it stays |
|---|---|---|
| one library agent per machine | managementAgent + market device picker | the picker (`market-device-readings.ts`) derives readings from the replicas with per-kind closures; folding needs a replica reader that is not data (proposal below) |
| configured connections per host | configuredConnections + market device picker | same picker |
| agent config / sign-in state | agentConfigList + auth-login-binding's state during a login | the login flow's own answer while it runs; folding needs the write-over-read join below |
| models a harness offers | sessionCreateModels + permissionMenu | two rpc transports (session timeline vs permission menu) with different shapes on dev; one source call needs a core change |
| assistant panel snapshot | replica + host's direct read while a replica read is in flight | a write must not be answered by a read that began before it; needs "a read that starts now, joining none begun earlier" on the replica |
| assistant panel snapshot (core) | core `assistantPanelFiles` 1 s cache | packages/core, not renderer; untouched |
| assistant connection list | connectionList + connection-replicas | both end in `readAssistantPanelIntegrations`; two keys (store vs host) |
| assistant workroom sources | 4 | needs per-machine session-list / bindings replicas in the session and projects stores (also the lane 4 row: LinkPill vs workroom sources) |
| my assistant / DM chat id | myAssistant + phoneBindingPorts | the App token check reads the row with stricter checks (phase, removed_at) |
| phone OS state | phoneOsState + heartbeat `readLatestOs` | the heartbeat must not publish a read whose session ended; the replica has no session notion |
| phone installation | replica + runtime snapshot `info` | the runtime snapshot keeps `info` for its own heartbeat |
| this device id | thisDeviceId + account-projects-store copy | MobX projects store |
| system permissions | 3 | Android battery guidance and the background watcher each read one native flag |
| own settings rows | ownSettings + chatPins + run-machine store | chat lane's pins, projects lane's defaults |
| subscriptions | subscriptionPlan with a connection id = connectionDetails | not folded |
| file storage / group machines | projectGroupMachines overlaps devices' `projects` | not folded |
| this computer's session list | LinkPill replica + workroom sources | as above |

## Mechanism changes (shared layer), each one path or one way of writing fewer

- `reread(...args)`: refresh and answer in one call (the refresh's own answer when shown). Replaces refresh-then-direct-read
  pairs in about 15 places.
- `readOnce(read, { retry })`: a one-off read with the replica's retry policy and no cache. MessageFilePreview,
  HtmlPreviewFrame and AssistantCloseHost go back to dev's effect shape instead of a fake replica or a hand retry loop.
- `useEntry(model, args)`: a write after an await lands in the account the render drew (AgentTasksPane,
  useGroupChatSettings, channelAgents) instead of three hand checks.
- `useReplica(..., { keepPrevious })`: palette and global search stop keeping their own last result.
- `valueOf(reading)`: one way of writing the `state === 'value' ? value : undefined` unwrap.
- A failed read is logged once per entry until it succeeds, by the replica: the catch-log-rethrow in readers is gone.
- `selectStore.set` and `patch` for Map stores: the hand copy/publish/notify goes.
- `ReadingSlot`: element placeholders and element failures, so row skeletons and failure cards use it; 3-state slots
  hand-drawn before now use it in about 20 more places.
- Source rule: one walk (`scanSource`) instead of five; exemptions are a list beside the rule
  (`effect-fetch-state-exemptions.txt`), not marker comments in product code.

## Cold review (17 items): changed / rejected

| # | item | disposition |
|---|---|---|
| 1 | marker comments for the script | changed: no markers in product code; exemption list with one reason per line |
| 2 | thin wrappers, one-use helpers | changed in every lane (≈20 wrappers deleted). Kept: `takenBack` (lint false positive on `record[id] ?? []`), `useCloudComputer` (17 callers) |
| 3 | not cached reads made into replicas | changed: MessageFilePreview, HtmlPreviewFrame (`readOnce`), useSessionRestart, AssistantCloseHost plan, quick chat back to dev's shape. Rejected: project-folders (persisted write-only entry; the snapshot budget is full) |
| 4 | three states hand-drawn | changed: ReadingSlot props + about 20 surfaces. Kept by hand where the state picks a component or splits across a row (named in each lane table) |
| 5 | paging / keep previous / retry loops | changed: keepPrevious, useReplicaPages for commits and legacy DM history, retry policy for GitHub accounts. Rejected: keepPrevious on the Extensions shelf (drops drawn pages when load-more fails) |
| 6 | repeated definition options | changed: `fresh: 0` default, shared `ofMachine`, one automation option set. Rejected: agentsMetadata vs managementAgents factory (different keys) |
| 7 | closure registries, three "this machine" forms | changed: machine-paths `'local'` gone, package source as the replica argument, CliInstallProgress counters. Rejected: market device registry, library host `hostsByKey` (identity vs state keys) |
| 8 | no "read now" | changed: `reread` |
| 9 | helpers not used | changed: `refreshFailure`, `retryOf`, `unwrap`, `model.key()` over `key()[1]`. Rejected: `replicaAccount` checks in ManagedVersionsRow and connectionBridge (an action checking its own account; the comment on `replicaAccount` now says so) |
| 10 | catch-log-rethrow | changed: the replica logs once per failing entry; removed in about 15 readers. Kept where the catch changes behaviour (cloud `not_open`, 42501) |
| 11 | test-only product code | changed: SSH link exports, iOS calendar seam, app presence injection, team `apiKey` registry. Kept: `assistantPanelBodies` factory (dev's shape) |
| 12 | select store shapes | changed: `set`, Map `patch`, `writeStream` setter factory, timeline-cache stores |
| 13 | old adapters beside new reads | changed: inventory string, chat-channel hook copies, connection-host adapter, subscribeCachedDevices. Rejected: integrations-provider Reading in context (other lanes' consumers) |
| 14 | the source rule | changed: `scanSource`, exemption list |
| 15 | replica.ts itself | changed: see mechanism list; the `replicaAccount` comment fixed |
| 16 | small duplicates | changed: `valueOf` (15 sites), `useOnChange`, `useHostMachine`. Kept: AppConversationSurfaceHost ref ("once per inventory while lapsed", not change-of-value) |
| 17 | squeezed lines, deleted comments | changed: squeezed lines split and contract comments restored in every lane (installed-extensions +48 comment lines, MainLayout, use-timeline-session, MessageFilePreview, …) |

## Lines (information, review basis)

Against dev 7db4b05f6, product code (outside tests): **+11348 −11126, net +222**; tests net +7249.
Review basis, excluding the two deleted dead files (app-featured 232 + app-market-content 240): **net +694**.
Added lines are still longer than removed ones (average 62.1 vs 53.5 characters; 1236 vs 689 lines over 120
characters, 287 of the added long ones are comments). Normalised by characters at dev's average line length, the net is
about +2175 lines (about +2962 at the start of the reopen).
