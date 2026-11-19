# App picture and input resources

Needs `agents:tools`

API 22 — scoped local previews and human input (desktop, `agents:tools`):

- In your Node program's task tool call, `gugu.projection.create(driver)` returns `{ id, publish, close }`.
  Main stamps the App and calling task; arguments cannot choose a different task, window, or webContents.
  `driver` supplies `driver.refresh()`, `driver.input(event, { viewer, frame, signal })`, `driver.disconnect(viewer)`, and `driver.close()`.
  Your App owns capture, target selection, permissions, and native input code. The host supplies transport and lifetime.
  `resource.publish({ width, height, mime, data })` takes a PNG/JPEG/WebP base64 picture, at most 512 KiB decoded;
  dimensions describe the source's input coordinates. It resolves with the runtime-assigned sequence.
  Keep that receipt mapped to the captured target. Before applying any input (including keys/text), check that
  `frame.sequence` still names the active target; reject target changes even when dimensions are unchanged.
  `input` receives normalized pointer/wheel coordinates, key down/up, or committed text (Chinese/clipboard once).
  Text carries `source: 'typing' | 'ime' | 'paste'`; `paste` names the local event, not proof of a remote clipboard
  or paste event. Your driver must distinguish plain text insertion from native paste and reject unsupported content.
  Finish or clean up native work before resolving it, including on `signal.abort`. A resolved void means applied;
  return `{ status: 'rejected', reason }` only if nothing was applied, or `{ status: 'unknown', reason }` when uncertain.
  A thrown error after dispatch is uncertain. No input is automatically replayed.
  `driver.disconnect(viewer)` releases that viewer's held keys/buttons before another viewer's input; `driver.close()` stops capture
  and input, and resolves after cleanup. Only one viewer drives at a time; others can still watch. App revocation,
  task archive/deletion, project deletion or withdrawn App access closes resources. An active task keeps its resources even without viewers.
- In the same App's task page, `gugu.projection.mount(element, id, { state?, error?, painted? })` returns `{ close, pendingText, discardPendingText }`.
  It draws the picture and accepts input there, with no extra text form. State is `connecting`, `live`, `input-paused`, or `closed`;
  The `painted` callback gives the actually painted `{sequence,width,height}`, or null when invalidated; match App decorations by sequence.
  Input is disabled until a fresh picture paints. Disconnects discard queued input; reconnects require a new generation.
  For the local preview feed, only one unacknowledged picture and the newest pending picture are retained.
  Focus loss invalidates the old input generation and releases its held input before fresh input is admitted.
  Rejection drops that operation and leaves the viewer usable. Unknown outcomes require a fresh generation.
  `view.pendingText()` returns `{ id, text, state: 'not-sent' | 'unconfirmed', reason? }` records.
  Read them before disposal if keeping a draft; explicitly discard one with `view.discardPendingText(id)`.
  Move/wheel events coalesce within the same frame and generation; discrete operations remain ordered.
  Your App decides where to mount a mirror; original local Browser pages already receive native input.
  Pictures never travel through App-wide program notifications or replayable tool calls.
  This bitmap feed is local only. A page on another computer requires the shared media transport; there is no
  bitmap-over-network, tool-result, cloud-notification or relay fallback. API 36 connects a remote task page through
  the authenticated direct media transport, using the same mount() call and input outcomes. Only a fresh decoded frame
  enables input; a sent control packet is not proof of execution. Main retains every proof and control key.

API 36 shared task resources (desktop, `agents:tools`):
- Program: `showTaskPages()` opens this App's declared perSession tabs beside its calling task, preserving the person's current tab.
  No task argument; needs a live task call. Returns tab kinds. Your App chooses first-use/retry policy; the host never reopens on its own.
- Custom stdio MCP adapters enter `gugu.withCall(request.params._meta, () => work())` in their tool handler;
  tools modules already enter it. Main checks the random call ID against this program's live calls, never tool arguments.
  Tools modules also receive `call.agentName` / `call.taskTitle` (same task name) and `call.callId`.
- Program: `gugu.pages.acquire({ url? })` returns `{ id, title, url, send, onMessage, onClose, close }`.
  Main selects the calling task's real page, never an App-supplied contents ID or partition. Adapt your own driver with
  `lease.send(method, params?, cdpSessionId?)`, `lease.onMessage(fn)` and `lease.onClose(fn)` (both return unsubscribe).
  Commands need a live call of that task. Protocol methods, navigation and child sessions remain host-restricted.
  Local file inputs (DOM.setFileInputFiles) are unavailable.
  Call cancellation ends its acquisition/commands, not the shared connection or other calls.
  Closing releases this lease's held keys/buttons and control, not the person's page or login. Task stop closes its old leases. A host without a desktop says unavailable.
- Protocol events carry no tool-call authority. `lease.maintain(method, params?, cdpSessionId?)` is App/program/task-owned initialization:
  Page.enable/getFrameTree, Log/Runtime/Network.enable, Runtime.runIfWaitingForDebugger, lifecycle enabled:true,
  empty-source named worlds (frame checked natively), fixed autoAttach/waitForDebuggerOnStart/flatten:true, screen media preferences, known-child detach.
  Main checks exact parameters; input/navigation/scripts/files/browser-wide commands are refused. Task stop, revocation or exit ends maintenance.
  Route it separately from live-call send; never borrow another call.
- Task page: `await gugu.pages.mount(element, id, {error?})` returns `{ close }`; mount only a lease of this App/task.
  Main clips its native page to the host-measured App viewport; native clicks go to the real page. Failed layout reports error and unmounts.
- Program: `await gugu.surfaces.open({ entry, bounds:{x,y,width,height}, data?, visible?, relativeTo? })` returns
  `{ id, shown:false, update, close, onEvent }` immediately, before native loading/display. `entry` is a bundle HTML file;
  bounds are screen DIP. `surface.update({ bounds?, data?, visible?, relativeTo? })`, `surface.close()`, `surface.onEvent(fn)` returns unsubscribe.
  Use `visible:false` to prepare a hidden handle; show it later. `relativeTo:{windowId:string}` places it directly
  above that native window, not permanently above unrelated Apps; null removes the relation.
  `gugu.surfaces.screen({bounds,space:'screen-dip'|'windows-screen-pixels'})` returns DIP `{bounds,workArea,scaleFactor}`.
  Windows pixel conversion uses native screenToDipRect; other hosts reject that pixel space. The App selects its window and placement.
  Events: `{id,type:'display',shown,reason?}`, `{id,type:'message',message}`, `{id,type:'closed',reason}`.
  Display failure is informational, never permission to reject, delay or authorize an action.
- Surface HTML uses its ordinary sandbox/grants; `getContext().surface` has `{id,data}`, refreshed with
  `onContextChanged`. Its buttons call `gugu.surfaces.post(message)` to its owning program.
  App: content, targets and Stop/Continue. Host: non-activation, capture protection and teardown. Decorations: `apps-surface-decoration`.
  An owned display can update outside a tool call. Normal tool completion does not cancel loading; actual interruption does.
  Revocation, program exit, task archive or project deletion closes it. Late native results are released.

Use `resource.close()` to release the source and `view.close()` to remove the mounted viewer.

App-owned pointer, target and operation display: [picture feedback (API58)](apps-picture-feedback.md).
