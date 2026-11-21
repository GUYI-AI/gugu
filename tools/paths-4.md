# Lane 4: read paths per kind of data (dev a62bb6b35 → head = rma-head + cut4)

Scope: session timeline / session views, chat surfaces, search, workspace / remote hosts / diff view, library.
A replica plus its readers is one path. One-off commands (a write, a check made at the moment of an action, a wait for
a state) are not read paths; they are named in the note.

| data | dev paths (where) | head paths (where) | note |
|---|---|---|---|
| a session's life view (lifecycle projection) | 2: `session-life-views.ts` mobx map (desktop); `useSessionLifeView.ts` effect + useState with its own push listener (phone) | 1: `session-life-views.ts` (views keyed by machine; the phone reads it through `phoneLifeRoute` + `lifeReadable`) | One-offs, not paths: `useSessionRestart` (the restart check), `sessionSendQueueHost` / `phone-send-queue-host` (the gate before releasing queued input), `acp-session-attachment` (waits for ready to attach). |
| a session's timeline stream (desktop + phone task page) | 2: `use-timeline-session.ts` useState copy; `timeline-cache.ts` memory map + persisted store (first frame) | 1: `timeline-cache.ts` stores (`sessionStreams`), the hook writes and reads them; persisted copy is the same module's first frame | `agentPresenceStore` reads snapshots for presence (a different kind: recent actions per agent). `assistantTimelineClient` / `phoneTimelineClient` / `sessionpage-rpc` are transports. |
| a session's native record (ACP sessions) | 2: `useNativeSessionRecord.ts` useState; `timeline-cache.ts` nativeMemory + persisted | 1: `timeline-cache.ts` `nativeRecordStreams` + persisted | `use-remember-native-tail.ts` writes the newest page into the same cache (prewarm writer, same copy). `phone-send-queue-host` tail read is the send gate (one-off). |
| a desktop task session's timeline facts (recent actions, settlements) | 1: `useSessionpageSessionTimeline.ts` useState | 1: `timeline-cache.ts` `sessionpageTimelineFacts` store | moved out of component state for the effect rule; same single path |
| command palette search results | 1: `command-palette-modal.tsx` useQuery | 1: `commandPaletteSearch` replica (same file) | |
| message search (global search, in: chat, everywhere count) | 1: `use-global-search.ts` useQuery (cloud + stored variants) | 1: `messageSearch` / `storedMessageSearch` replicas (same file) | `app-messages-core.ts` calls `message_search_as` for an App's own search API (lane 1's App host; a one-off answer to an App call). |
| task turn search + index status | 1: `use-global-search.ts` useQuery | 1: `taskTurnSearch` replica | |
| a PR's / branch's commits | 1: `use-commits.ts` paging query | 1: `commitPage` replica through `useReplicaPages` | |
| a commit's changed files | 1: `use-commit-files.ts` query + `useCommitFiles` wrapper | 1: `commitFiles` replica | wrapper removed (round 1) |
| a PR's comments | 1: `use-pull-request-comments.ts` | 1: same, replica | |
| an image at a git ref / in the index (diff sides) | 1: `image-diff-view.tsx` | 1: `imageDiffSide` replica | |
| an image file in a workspace on disk | 2: `diff-file-renderer.tsx` resolveImage (markdown) effect; `image-diff-view.tsx` loadFromDisk | 1: `workspaceImage` replica (`workspace-image.ts`), read by markdown images and the diff's working-tree side | folded in round 3 (commit 9dabb6c7c) |
| the file a preview opens (bytes per opening) | 1: `MessageFilePreview.tsx` fetchQuery per opening | 1: same effect, `readOnce` per opening | one read per opening by design (a withdrawn file must not keep showing); not cached |
| an HTML preview's registration | — | — | lifecycle command (register / release), not a read: `HtmlPreviewFrame.tsx` via `readOnce` |
| port forwards of a machine | 2: `remote-ports-tab-view.tsx` useState; `remote-forward-cache.ts` module Map (address bar lookup) | 1: `remotePortForwards` replica (`remote-ports-replicas.ts`), `peek` for the address bar | |
| ports listening on a machine | 1: `remote-ports-tab-view.tsx` useState | 1: `machineListeningPorts` replica | `machine-session-wiring.ts` scanner asks `ownPorts` when output names a port (a one-off decision, not shown) |
| a folder listing on another machine | 1: `RemoteFolderPicker.tsx` state | 1: `remoteDirectory` replica (`lib/remoteDirectory.ts`) | `assistant-machine-core` / `assistant-move-wire` list folders for a move (lane 3 commands) |
| SSH machine addresses on this desktop | 2: `useSshMachines.ts` useState; `sshLinkChannel.ts` own registry copy | 1: `sshMachineAddresses` replica | |
| SSH link problems / upgrades | 1: `sshLinkChannel.ts` Maps + own subscribe | 1: `sshLinkChannel.ts` selectStores (`patch`) | test-only subscribe exports removed (round 1) |
| this computer's home folder | 3: `local-folder-project-modal.tsx` effect; `open-file-in-file-editor.ts` module promise; `sidebar-identity-card.tsx` store field | 1: `homeDirectory` replica (`machine-paths.ts`) | sidebar card folded in round 3 (708e2fb75). `assistant-machine.ts:17` still calls `rpc.app.getHomeDirectory()` for a local home at the moment of placing an assistant (one-off; lane 3 file; could be `homeDirectory.fetch()`). |
| another machine's home folder | 1: `remote-hosts-store.ts` `homeDirs` + `ensureHomeDir` (+ the device row's `homeDir`) | 1: same | stays a store field; folding it into `homeDirectory(machine)` waits for lane 2's single "this machine" form in machine-paths. `assistant-execution.ts` reads it for a run (one-off). |
| what a typed path is (folder / git repo) | 1: `local-folder-project-modal.tsx` effect | 1: `projectPathInspection` replica | the drop / attach / create sites (`use-sidebar-drop`, `attachPhoneProjectFolder`, `PhoneNewProjectPage`, `project-folder-stage`, `project-manager`, `sample-composer`) inspect once for an action (one-off) |
| legacy DM chats / messages | 1 each: `LegacyDmHistory.tsx` state + manual paging | 1 each: `legacyDmList` / `legacyDmMessages` through `useReplicaPages` | |
| a widget's last picture | 2: `WidgetSnapshot.tsx` module Map `decoded`; per-slot effect re-read on `WIDGET_SNAPSHOT_EVENT` | 1: `widgetSnapshot` replica (`lib/widgetSnapshot.ts`); the capture writes it with `at().set` | |
| this computer's session list (titles for links, workrooms) | 2: `LinkPill.tsx` `link-pill-sessions` replica; `useAssistantWorkrooms.ts` `assistantWorkroomSources` | 2: same | stays at 2 — see report. `resourceActions`, `assistant-move-wire`, `AssistantCloseHost` list sessions for an action (one-off); `remote-hosts-store.syncProjects` is another machine's list. |
| a reading's failure log | many: per-surface `useEffect` logging `reading.error` | 1: `readFromKey` logs each failed read once | round 2/3 removed the effect copies (flood notice, flood threshold, task card join, markdown image, account settings, resource history) |

Totals: 26 rows = 24 kinds of data read, the HTML preview registration (a command, 0 paths) and the failure log.
Paths: dev 37, head 27 (the failure log counted as 2 at dev for its many copies, 1 at head; legacy DM counts 2, its
two kinds).
