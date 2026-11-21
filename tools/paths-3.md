# Read paths per data kind, lane 3 (assistant panel, cloud computer, devices, phone, settings)

dev = a62bb6b35, head = cut3 after round 3 (rma-head 3fd6dec0f merged). A replica plus its readers is one path. Counts
exclude tests. Paths under `apps/desktop/src/` unless said. "action" = a read inside a one-off command (skipped).

Totals: **43 rows (data kinds), dev 100 paths, head 74 paths** (75 at the lane's report; phone OS state folded after).

| data | dev paths (where) | head paths (where) | note |
|---|---|---|---|
| assistant panel snapshot | 5: assistant-panel-cache.ts store (IndexedDB + localStorage mirror); core assistantPanelFiles.ts 1 s `cached`; PhoneMemory usePhoneRead; assistant-data `useOwnSkills` react-query; usePhoneConnectorAccounts usePhoneRead | 2: `assistantPanel` replica (collections, panel-files adapter, onAssistantPanelChanged); core assistantPanelFiles.ts 1 s `cached` | assistant-panel-host.ts:27-33 reads `panelSnapshot` directly while a replica read is on its way, then puts it in the entry: a second way of writing (I2: a read that began before a write must not answer it). Stays, see proposals |
| assistant connection list per store | 3: usePhoneProfileData, assistant-app-counts (usePhoneRead), integrations-provider 3 react-query | 2: `connectionList` replica; connection-replicas.ts `integrationsCatalog`/`integrationStatuses`/`configuredConnections` via connection-library-host `read()` | both end in `readAssistantPanelIntegrations`; connection-replicas is lane 2's |
| integration detail | 4: integrationDetails WeakMap, useAssistantPanelIntegration react-query, usePhoneProfileData, useAssistantIntegrationSummaries module cache | 1: `assistantIntegrationDetail` | |
| memory note body | 1: AssistantMemoryContent usePhoneRead | 1: `assistantMemoryBody` | |
| assistant workroom sources | 4: useAssistantWorkrooms effect, project-groups-store bindings, LinkPill sessions, remote-hosts-store syncProjects | 4: `assistantWorkroomSources` + the same 3 | per-machine sessions list / bindings replicas would fold all four (session + project lanes' files) |
| quick chat state | 2: useQuickChatState copy per caller | 1: `quickChatState` | |
| my assistant identity | 4: myAssistant module store, assistant-panel-cloud personalAssistant, phoneBindingPorts, legacy-dm-history/data | 3: `myAssistant`; phoneBindingPorts.ts:61; legacy-dm-history/data.ts:34 | phoneBindingPorts verifies the binding with stricter row checks (phase, dm_chat_id, removed_at) for an App's token: appSlot (lane 1) |
| assistant DM chat id | 3: useAssistantDm effect, assistantPrivateChat react-query, phoneBindingPorts dm_chat_id | 2: `assistantDm`; phoneBindingPorts | same as above |
| assistant rules state | 1 | 1: `assistantRulesState` | |
| assistant today/ideas | 1: usePhoneToday effect | 1: `assistantToday` | |
| phone health | 1: usePhoneRead | 1: `phoneHealth` | phoneOsState also calls `healthStatus()` (part of the OS state) |
| iOS calendar connection | 1: panel useState | 1: `iosCalendarConnection` | a second way of writing stays: after a lost connect/disconnect reply the panel reads `client.read(startedFor)` and puts it in the entry. Tried `reread()`: 9 tests fail (it reads for whoever is signed in, and twice at `fresh: 0`); reverted |
| phone task skills | 1 | 1: `phoneTaskSkills` | |
| phone OS state | 2: runtime snapshot `os`, PhonePermissionsList direct read | 2: `phoneOsState` (PhonePermissionsList reads after a request through `reread`, c92b9c28b); phoneDeviceRuntime `readLatestOs` (reads, then `set`) | the page's direct read folded after the `reread` fix; `readLatestOs` stays: the heartbeat must not publish a read whose session ended (`isCurrent`), which the replica has no notion of |
| phone installation | 3: PhoneAgentSetupGate effect, runtime `info`, androidBatteryGuidance deviceInfo | 3: `phoneInstallation`; runtime `info` copy; `androidBatteryGuidance` replica | fold needs the runtime snapshot to drop `info`; not done this round |
| server login request | 1 | 1: `serverLoginRequest` | decide answer in local state (action) |
| move recovery | 2: AssistantMoveGroup effect, pendingMove in render | 1: `moveRecovery` | `sourceHomeFor` reads pendingMove during a move (action) |
| assistant work records | 3: module store, useTaskChatRows listAll + Map, resolveAssistantWorkTarget | 1: `assistantWorkRecords` (+ `assistantWork` per work) | round 3: the link resolver rereads the replica |
| device meetings | 2: MeetingReminder poll, AssistantSection effect | 1: `deviceMeetings` | |
| cloud computer state | 1: cloudComputerStore | 1: `cloudComputer` | readCloudSnapshotNow = reread; client used only for actions |
| account device list | 1 (+2 mirrors) | 1 (+2 mirrors): devicesModel; session-directory publish, useRemoteHostsBridge ref | `listDevicesOnceIdentified` direct listDevices is an action read (row shape differs: no phones) |
| this device id | 3: ComposerCardView, task-dispatch-composer, account-projects-store | 2: `thisDeviceId`; account-projects-store.ts:120 mobx copy | projects lane's store; `is_current_device` lookups are a second way of writing |
| this device actions | 1 | 1 | |
| SSH sign-in state | 1 | 1 | |
| SSH machine addresses | 2 | 1: `sshMachineAddresses` | |
| tunnel links / link problems | 3 | 2: `tunnelLinks`; problems selectStore (event-fed, no source read) | |
| system permissions | 3: hook effect, androidBatteryGuidance, AndroidChatBackgroundWatch | 3: `systemPermission`, androidBatteryGuidance, AndroidChatBackgroundWatch effect | not folded this round |
| unavailable projects | 1 | 1: `unavailableProjects` | round 3: the archive check reads through the replica (was a direct list call); one-line wrappers removed |
| credit account | 4 | 1: `creditAccount` | |
| password vault | 2 | 1: `passwordVault` | |
| password save draft | 1 | 1: `passwordSaveDraft` | |
| app settings | 4: appSettingsModel, PhoneNewProjectPage effect, remote-hosts-store getWithMeta, use-pty get | 1: `appSettingsModel` | round 3: wait banners and terminal font read `fetchAppSettingValue` |
| own settings rows | 3: ownSettings, chatPins over it, project-run-machine store | 3: ownSettings/chatOwnSettings, chatPins, project-run-machine store | chatPins (chat lane) and agentCreateDefaults (projects) not folded |
| SSH config hosts / install info | 2 | 2 (two kinds, one replica each) | |
| machine limit check / refusals | 2 | 2 (two kinds, one replica each) | |
| login methods | 1 (+ a second way: controller.read + set) | 1 | round 3: reads after an action are the replica's reread |
| Google provider enabled | 1 | 1 | |
| file storage overview / group machines | 2 | 2 | projectGroupMachines overlaps devices' `projects` (not folded) |
| data import (history, counts, upgrade results) | 4: replicas + FirstRunGate direct upgrade read (configHome counted with agent home) | 3: one replica each | round 3: FirstRunGate fetches `agentHomeUpgradeResults` |
| agent home (provider config home) | 2: AgentHomeRow `agentHome`, AgentConfigImport `configHome` + own 1 s interval | 1: `agentHome` (ensure-agent-home.ts) | round 3 fold; `openAgentHomeImport` reads directly (action) |
| settings cards | 6: defaultBrowser, revokedPermissions + ExtensionsSettingsCard effect, sessionTitleModels, installedFonts, resourceHistory | 5 | |
| subscriptions | 8 | 8 | subscriptionPlan with a connection id = connectionDetails' read (not folded) |
| usage devices | 1 | 1 | |
| phone market catalog | 1 | 1 | marketOffers on the phone reads the same entries (lane 1) |

## Proposal: a live object passed beside the key (coordinator decides)

Today a replica's arguments are its cache key, so a read that needs a live object (a store, a machine handle, an api
client) registers it in a module Map under a string key and looks it up inside `read` (a failed lookup is a failed read).

API: `replica({ ..., read: (owner, ...args, context) => ... , context: true })` with readers passing it beside the args:
`useReplica(model, args, { context: value })`, `model.fetch(...args).with(value)` / `model.refresh(...)` unchanged. The key
is still `args` only (the caller names the identity in the args, e.g. `connectionMetadataKey(store)`); the replica keeps
the latest context per entry and hands it to `read`, `local` and `watch.start`. An entry with no context yet is `unknown`
(❌ a failed read, as the hand registries do now).

Sites it removes (the hand registries and their lookups):
- `components/assistant/assistant-panel-reads.ts`: `stores` + `registerConnectionStore` + `storeOf` (connectionList,
  assistantIntegrationDetail; `local` also peeks `stores.get`), `machines` + `registerAssistantMachine` + `machineOf`
  (assistantMemoryBody). About 25 lines and one "not registered" failure mode.
- `S/features/team/replicas.ts:10-25` (COLD-REVIEW #11): `apis` Map + `keys` WeakMap + `teamApiKey`/`apiOf` threaded
  into 6 reads.

Cost: `replica.ts` grows by the context slot (one field per entry, one parameter). If only these two sites use it, the
registries are cheaper; it pays only if a third site appears.

## Findings for the coordinator

- `reread` = `refresh()` then `fetch()`. For a model with `fresh: 0` (the default) `fetch` finds the refreshed value
  already stale and reads again: two source reads per `reread`. Seen while folding `phoneOsState` (native call on every
  permission change), not folded for that reason. Models in this lane rereading with `fresh: 0`:
  `loginMethodsModel`, `unavailableProjects` (rare, after an action). Fix belongs in `replica.ts` (return the refresh's own
  answer).
- Panel snapshot I2 join (assistant-panel-host.ts:27-33): a "read that starts now, joining none begun before" operation
  on the replica would remove the hand read + `entry.set` there.
