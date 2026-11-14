import { verbFacts, type ExtensionHostEvent } from './bridge-protocol';

/**
 * The host half of `window.gugu` (the runtime builds the public half on top of it, `create-gugu.ts`), one row per member:
 * the verb it asks for and how its arguments travel. Every host builds its members from these rows — the desktop preload
 * over IPC, the phone's frame and an App's program over messages (`framed-host.ts`) — so a verb is packed one way only,
 * and who has it is its `BRIDGE_VERBS` row (`only`) and what that host answers (`offers`), never a second hand-written copy.
 * Everything here is a request: main and the phone's host decide every answer.
 */
type Pack = (...args: never[]) => unknown;
interface HostCall {
  verb: string;
  /** The positional arguments as the verb's one argument object; absent: the first argument as it is. */
  pack?: Pack;
}

const same = (args?: unknown) => args;

export const HOST_CALLS = {
  taskMessage: { verb: 'taskMessage' },
  showTaskPages: { verb: 'showTaskPages', pack: () => ({}) },
  'projectionMedia.open': { verb: 'projectionMediaOpen' },
  'projectionMedia.answer': { verb: 'projectionMediaAnswer' },
  'projectionMedia.sign': { verb: 'projectionMediaSign' },
  'projectionMedia.close': { verb: 'projectionMediaClose' },
  'surfaces.open': { verb: 'appSurfaceOpen' },
  'surfaces.screen': { verb: 'appSurfaceScreen' },
  'surfaces.update': { verb: 'appSurfaceUpdate' },
  'surfaces.close': { verb: 'appSurfaceClose' },
  'surfaces.post': { verb: 'appSurfacePost' },
  'pages.acquire': { verb: 'taskPageAcquire' },
  'pages.send': { verb: 'taskPageSend' },
  'pages.maintain': { verb: 'taskPageMaintain' },
  'pages.presentation': { verb: 'taskPagePresentation' },
  'pages.filePayloads': { verb: 'taskPageFilePayloads' },
  'pages.release': { verb: 'taskPageRelease' },
  'pages.mount': { verb: 'taskPageMount' },
  'pages.unmount': { verb: 'taskPageUnmount' },
  'projection.create': { verb: 'projectionCreate' },
  'projection.publish': { verb: 'projectionPublish' },
  'projection.close': { verb: 'projectionClose' },
  'projection.closed': { verb: 'projectionClosed' },
  'projection.inputResult': { verb: 'projectionInputResult' },
  'projection.watch': { verb: 'projectionWatch' },
  'projection.unwatch': { verb: 'projectionUnwatch' },
  'projection.send': { verb: 'projectionSend' },
  'modal.open': { verb: 'modalOpen' },
  'modal.close': { verb: 'modalClose', pack: (result: unknown = null) => ({ result }) },
  'modal.key': { verb: 'modalKey', pack: (key: string) => ({ key }) },
  getContext: { verb: 'getContext' },
  navigationGo: { verb: 'navigationGo' },
  navigationClaimBack: { verb: 'navigationClaimBack', pack: (claimed: boolean) => ({ claimed }) },
  showContextMenu: { verb: 'showContextMenu' },
  getAppState: { verb: 'getAppState' },
  openBrowserTab: { verb: 'openBrowserTab', pack: (url: string) => ({ url }) },
  /** `level: 'hint'` (摩擦单 F62): a note for the App's author, recorded, no red dot. */
  reportError: { verb: 'reportError', pack: (message: string, options?: { level?: 'error' | 'hint' }) => ({ message, ...(options?.level === 'hint' ? { level: 'hint' } : {}) }) },
  /** How wide the answer is was settled at install, never at the call: no scope argument (behavior tab-extensions). */
  listAgents: { verb: 'listAgents', pack: (options?: { report?: boolean }) => options?.report === true ? { report: true } : {} },
  readAgentHistory: { verb: 'readAgentHistory', pack: (agentId: string, before?: number) => ({ agentId, ...(before === undefined ? {} : { before }) }) },
  stopAgent: { verb: 'stopAgent', pack: (agentId: string) => ({ agentId }) },
  /** `gugu.dispatch(text, options)` (15): the one way to hand something to someone; `images` arrive as bytes (create-gugu.ts). */
  dispatch: { verb: 'dispatch', pack: (text: string, options?: Record<string, unknown>) => ({ ...options, text }) },
  // A chat's messages (`chat:read`): each call names its chat, as a file call names its place.
  'bindings.get': { verb: 'bindingsGet', pack: (name: string) => ({ name }) },
  // #1927 (40, `chat:files`): the bound conversation's files, named by the binding and a path there, never by a chat.
  'bindings.list': { verb: 'bindingsList', pack: (name: string, options?: Record<string, unknown>) => ({ ...options, name }) },
  'bindings.read': { verb: 'bindingsRead', pack: (name: string, path: string) => ({ name, path }) },
  // #1925 (41, `chat:surface`): the conversation drawn beside this page — shown or not, the panel collapsed or not.
  'bindings.surface': { verb: 'bindingsSurface', pack: (name: string) => ({ name }) },
  'bindings.setPanel': { verb: 'bindingsSurfacePanel', pack: (name: string, options?: Record<string, unknown>) => ({ ...options, name }) },
  // #1927 (42, `chat:resources` / `chat:resources:write`): the bound conversation's agent's resources, named by the binding, a
  // domain and a key; `onResourcesChanged` rides on `watch` and `onBindingResources` (create-gugu.ts).
  'bindings.resources': { verb: 'bindingsResources', pack: (name: string, domain: string) => ({ name, domain }) },
  'bindings.resource': { verb: 'bindingsResource', pack: (name: string, domain: string, key: string) => ({ name, domain, key }) },
  'bindings.watch': { verb: 'bindingsWatch', pack: (watchId: string, name: string, on: boolean) => ({ watchId, name, on }) },
  'bindings.save': { verb: 'bindingsSave', pack: (name: string, change: Record<string, unknown>) => ({ ...change, name }) },
  'bindings.remove': { verb: 'bindingsRemove', pack: (name: string, change: Record<string, unknown>) => ({ ...change, name }) },
  // 50 (resources-management.ts): 给助理的资料 and voice notes, as the assistant's own pages manage them.
  'bindings.upload': { verb: 'bindingsUpload', pack: (name: string, options?: { folder?: string }) => ({ ...(options ?? {}), name }) },
  'bindings.createFolder': { verb: 'bindingsCreateFolder', pack: (name: string, key: string) => ({ name, key }) },
  'bindings.rename': { verb: 'bindingsRename', pack: (name: string, key: string, to: string) => ({ name, key, to }) },
  'bindings.removeFolder': { verb: 'bindingsRemoveFolder', pack: (name: string, key: string) => ({ name, key }) },
  'bindings.transcribeVoiceNote': { verb: 'bindingsTranscribeVoiceNote', pack: (name: string, key: string) => ({ name, key }) },
  'bindings.removeVoiceNote': { verb: 'bindingsRemoveVoiceNote', pack: (name: string, key: string) => ({ name, key }) },
  'bindings.exportVoiceNote': { verb: 'bindingsExportVoiceNote', pack: (name: string, key: string) => ({ name, key }) },
  // #1928 (43, `chat:schedules` / `chat:schedules:control`): the bound agent's schedules, named by the binding, never by an agent.
  'bindings.schedules': { verb: 'bindingsSchedules', pack: (name: string) => ({ name }) },
  'bindings.watchSchedules': { verb: 'bindingsSchedulesWatch', pack: (name: string, on: boolean) => ({ name, on }) },
  'bindings.controlSchedule': { verb: 'bindingsScheduleControl', pack: (name: string, change?: Record<string, unknown>) => ({ ...change, name }) },
  // #1925 (44, `assistant:status` / `assistant:open`): the bound conversation's assistant, named by the binding alone.
  'assistant.status': { verb: 'assistantStatus', pack: (name: string) => ({ name }) },
  'assistant.open': { verb: 'assistantOpen', pack: (name: string, screen: string) => ({ name, screen }) },
  'assistant.advanceSetup': { verb: 'assistantAdvanceSetup', pack: (name: string, next: string) => ({ name, next }) },
  'assistant.rename': { verb: 'assistantRename', pack: (name: string, text: string) => ({ name, text }) },
  'assistant.figure': { verb: 'assistantFigure', pack: (name: string, figure: unknown = null) => ({ name, figure }) },
  'assistant.connect': { verb: 'assistantConnect', pack: (name: string, id: string) => ({ name, id }) },
  // #1925 (46, `chat:work`): the assistant's work, by the binding's name, and one row's conversation by the handle it came with.
  'bindings.work': { verb: 'bindingsWork', pack: (name: string) => ({ name }) },
  'bindings.openWork': { verb: 'bindingsOpenWork', pack: (name: string, handle: string) => ({ name, handle }) },
  'bindings.closeWork': { verb: 'bindingsCloseWork', pack: (name: string) => ({ name }) },
  // #1927 (47, `chat:voice-notes:record`): the host's voice-note recorder, named by the binding; `onChanged` rides on `watch`
  // and `onVoiceNote` (create-gugu.ts).
  'voiceNote.start': { verb: 'voiceNoteStart', pack: (name: string, options?: Record<string, unknown>) => ({ ...options, name }) },
  'voiceNote.pause': { verb: 'voiceNotePause', pack: (name: string) => ({ name }) },
  'voiceNote.resume': { verb: 'voiceNoteResume', pack: (name: string) => ({ name }) },
  'voiceNote.stop': { verb: 'voiceNoteStop', pack: (name: string) => ({ name }) },
  'voiceNote.retry': { verb: 'voiceNoteRetry', pack: (name: string, job: string) => ({ name, job }) },
  'voiceNote.openMicSettings': { verb: 'voiceNoteOpenMicSettings', pack: (name: string) => ({ name }) },
  'voiceNote.status': { verb: 'voiceNoteStatus', pack: (name: string) => ({ name }) },
  'voiceNote.watch': { verb: 'voiceNoteWatch', pack: (watchId: string, name: string, on: boolean) => ({ watchId, name, on }) },
  'messages.history': { verb: 'messagesHistory' },
  'messages.search': { verb: 'messagesSearch' },
  // The chats whoever reads is in, and one's members (`chat:read`): `{ chat }` names it.
  'chats.list': { verb: 'chatsList', pack: () => ({}) },
  'chats.members': { verb: 'chatsMembers' },
  // This computer's projects (`files:read`): each one's folder is a place, `{ project: id }`.
  'projects.list': { verb: 'projectsList', pack: () => ({}) },
  // `gugu.cloud.*` (31), composed in create-gugu.ts (`on` rides on subscribe + `onCloudHeard`).
  'cloud.read': { verb: 'cloudRead', pack: (name: string, args?: Record<string, unknown>) => ({ name, args }) },
  'cloud.write': { verb: 'cloudWrite', pack: (name: string, args?: Record<string, unknown>) => ({ name, args }) },
  'cloud.programWrite': { verb: 'cloudProgramWrite', pack: (name: string, args?: Record<string, unknown>) => ({ name, args }) },
  'cloud.subscribe': { verb: 'cloudSubscribe', pack: (topic: string, event: string) => ({ topic, event }) },
  'cloud.unsubscribe': { verb: 'cloudUnsubscribe', pack: (topic: string, event: string) => ({ topic, event }) },
  // `gugu.prompts` (34, `prompts`): the person's own prompts; a delete is shown to the person with its undo.
  'prompts.list': { verb: 'promptsList', pack: (args: Record<string, unknown> = {}) => args },
  'prompts.save': { verb: 'promptsSave' },
  'prompts.delete': { verb: 'promptsDelete', pack: (id: string) => ({ id }) },
  pickAgent: { verb: 'pickAgent' },
  readData: { verb: 'readData', pack: (path: string) => ({ path }) },
  writeData: { verb: 'writeData', pack: (path: string, content: string) => ({ path, content }) },
  listData: { verb: 'listData', pack: (dir = '.') => ({ path: dir }) },
  callProgram: {
    verb: 'callProgram',
    pack: (tool: string, args?: Record<string, unknown>, options?: string | { server?: string; device?: string }) => ({ name: tool, ...(args === undefined ? {} : { arguments: args }), ...(typeof options === 'string' ? { server: options } : options) }),
  },
  'sessions.index': { verb: 'sessionsIndex', pack: (options?: Record<string, unknown>) => ({ ...options }) },
  'sessions.read': { verb: 'sessionsRead' },
  notify: { verb: 'notify' },
  // #1925 (44) The host's own toast, a short line while the page is on screen and focused.
  toast: { verb: 'toast', pack: (text: string) => ({ text }) },
  openLink: { verb: 'openLink', pack: (url: string) => ({ url }) },
  linkTo: { verb: 'linkTo', pack: (options: Record<string, unknown> = {}) => options },
  setTabTitle: { verb: 'setTabTitle', pack: (title: string) => ({ title }) },
  setTabBadge: { verb: 'setTabBadge', pack: (badge: number | string | null) => ({ badge }) },
  setTabDirty: { verb: 'setTabDirty', pack: (tabId: string, dirty: boolean) => ({ tabId, dirty }) },
  sendToBackground: { verb: 'sendToBackground', pack: (message: unknown) => ({ message }) },
  broadcastToViews: { verb: 'broadcastToViews', pack: (message: unknown) => ({ message }) },
  showMessage: { verb: 'showMessage', pack: (id: string) => ({ id }) },
  showSession: { verb: 'showSession', pack: (id: string, options?: { peek?: boolean }) => ({ id, ...(options?.peek === true ? { peek: true } : {}) }) },
  'clipboard.writeText': { verb: 'clipboardWriteText', pack: (text: string) => ({ text }) },
  // Every file call names where its file is (真源原则 13): its argument object travels as it is.
  'appFiles.open': { verb: 'filesOpen' },
  'appFiles.reopen': { verb: 'filesReopen' },
  'appFiles.close': { verb: 'filesClose' },
  'appFiles.list': { verb: 'filesList' },
  'appFiles.read': { verb: 'filesRead' },
  'appFiles.readText': { verb: 'filesReadText' },
  'appFiles.exists': { verb: 'filesExists' },
  'appFiles.draft': { verb: 'filesDraft' },
  'appFiles.writeText': { verb: 'filesWriteText' },
  'appFiles.search': { verb: 'filesSearch' },
  'appFiles.recent': { verb: 'filesRecent' },
  'appFiles.create': { verb: 'filesCreate' },
  'appFiles.viewPreferences': { verb: 'filesViewPreferences' },
  'appFiles.remove': { verb: 'filesRemove' },
  'appFiles.rename': { verb: 'filesRename' },
  'appFiles.keep': { verb: 'filesKeep' },
  'appFiles.mkdir': { verb: 'filesMkdir' },
  'appFiles.move': { verb: 'filesMove' },
  'appFiles.writeChunk': { verb: 'filesWriteChunk' },
  'appFiles.reveal': { verb: 'filesReveal' },
  'appFiles.openInApps': { verb: 'filesOpenInApps' },
  'appFiles.openIn': { verb: 'filesOpenIn' },
  'appFiles.downloadStop': { verb: 'filesDownloadStop' },
  'appFiles.watch': { verb: 'filesWatch' },
  'appFiles.replace': { verb: 'filesReplace' },
  'appFiles.canDelete': { verb: 'filesCanDelete' },
  'appFiles.versions': { verb: 'filesVersions' },
  'appFiles.readVersion': { verb: 'filesReadVersion' },
  /** Bytes the caller has, or (no `files`) the person's picker — a page's, inside a gesture. */
  'appFiles.upload': {
    verb: 'filesUpload',
    pack: (args: { place?: unknown; files?: unknown; sourceMessageIds?: unknown; folder?: unknown }) => ({
      place: args?.place,
      ...(Array.isArray(args?.files) ? { files: args.files } : { pick: true }),
      sourceMessageIds: args?.sourceMessageIds,
      ...(typeof args?.folder === 'string' ? { folder: args.folder } : {}),
    }),
  },
  'appFiles.openWith': { verb: 'filesOpenWith' },
  'appFiles.download': { verb: 'filesDownload' },
  'appFiles.forward': { verb: 'filesForward' },
} satisfies Record<string, HostCall>;

type Event<T extends ExtensionHostEvent['type']> = Extract<ExtensionHostEvent, { type: T }>;
interface HostEvent {
  event: ExtensionHostEvent['type'];
  /** Who hears it, when not every caller does — as a verb's `only`. */
  only?: 'page' | 'background' | 'program';
  /** What the handler is called with. */
  pick: (event: never) => unknown[];
}

/** The events a host hands on, one row per `on…` member: which event, and what the handler gets of it. */
export const HOST_EVENTS = {
  onSurface: { event: 'appSurface', only: 'program', pick: (event: Event<'appSurface'>) => [event.event] },
  onTaskPage: { event: 'taskPage', only: 'program', pick: (event: Event<'taskPage'>) => [event.event] },
  onProjection: { event: 'projection', only: 'page', pick: (event: Event<'projection'>) => [event.watchId, event.packet] },
  onProjectionSource: { event: 'projectionSource', only: 'program', pick: (event: Event<'projectionSource'>) => [event.event] },
  onModalFocus: { event: 'modalFocus', only: 'page', pick: (event: Event<'modalFocus'>) => [event.edge] },
  onContextChanged: { event: 'context', pick: (event: Event<'context'>) => [event.context] },
  /** `gugu.bindings.onSurface(fn)` (41): what `bindings.surface` answers, each time it changes. */
  'bindings.onSurface': { event: 'bindingSurface', only: 'page', pick: (event: Event<'bindingSurface'>) => [event.surface] },
  /** `gugu.bindings.onWorkChanged(name, fn)` rides on it (46, create-gugu.ts): what `bindings.work` answers, each time it changes. */
  'bindings.onWork': { event: 'bindingWork', only: 'page', pick: (event: Event<'bindingWork'>) => [event.work] },
  /** `gugu.files.onChanged(place, fn)` rides on it; it says files moved, never who moved them. */
  onFilesChanged: { event: 'filesChanged', pick: (event: Event<'filesChanged'>) => [event.watchId, event.change] },
  /** `gugu.files.download(file, { onProgress })` rides on it. */
  onDownloadProgress: { event: 'downloadProgress', only: 'page', pick: (event: Event<'downloadProgress'>) => [event.transferId, event.done, event.total] },
  onAppStateChanged: { event: 'appState', pick: (event: Event<'appState'>) => [event.state] },
  onAgentsChanged: { event: 'agentsChanged', pick: (event: Event<'agentsChanged'>) => [event.agentIds] },
  /** `gugu.assistant.onChanged(fn)` rides on it (#1925): the answer `status` gives, to a page the person works. */
  onAssistantChanged: {
    event: 'assistantChanged', only: 'page',
    pick: (event: Event<'assistantChanged'>) => [event.state === 'ready'
      ? { name: event.name, state: event.state, status: event.status, hostPage: event.hostPage }
      : { name: event.name, state: event.state }],
  },
  onCloudHeard: { event: 'cloudHeard', only: 'page', pick: (event: Event<'cloudHeard'>) => [event.topic, event.event, event.heard] },
  onBindingResources: { event: 'bindingResources', only: 'page', pick: (event: Event<'bindingResources'>) => [event.watchId, event.event] },
  /** `gugu.bindings.onSchedulesChanged(name, fn)` rides on it (#1928): which binding's agent's schedules changed. */
  onSchedulesChanged: { event: 'schedulesChanged', only: 'page', pick: (event: Event<'schedulesChanged'>) => [event.binding] },
  onVoiceNote: { event: 'voiceNote', only: 'page', pick: (event: Event<'voiceNote'>) => [event.watchId, event.event] },
  onProgramNotification: {
    event: 'programNotification',
    pick: (event: Event<'programNotification'>) => [{ server: event.server, method: event.method, ...(event.params === undefined ? {} : { params: event.params }) }],
  },
  onNotificationClicked: {
    event: 'notificationClicked',
    pick: (event: Event<'notificationClicked'>) => [{ ...(event.tag === undefined ? {} : { tag: event.tag }), ...(event.data === undefined ? {} : { data: event.data }) }],
  },
  onLink: { event: 'link', pick: (event: Event<'link'>) => [{ tab: event.tab, path: event.path, query: event.query, file: event.file }] },
  onCommand: { event: 'command', only: 'page', pick: (event: Event<'command'>) => [event.commandId] },
  onBack: { event: 'back', only: 'page', pick: () => [] },
  onBackgroundMessage: { event: 'from-background', only: 'page', pick: (event: Event<'from-background'>) => [event.message] },
  onViewMessage: { event: 'from-view', only: 'background', pick: (event: Event<'from-view'>) => [event.message, event.from] },
} satisfies Record<string, HostEvent>;

export type HostMember = keyof typeof HOST_CALLS | keyof typeof HOST_EVENTS;
export type HostCaller = 'page' | 'background' | 'program';

/**
 * #6387 Events a page may not be listening for yet when they arrive — a link, command or banner click that opened this page
 * lands while its script is still loading: held for the first subscriber, the newest kept (a page that never subscribes
 * must not grow it forever).
 */
const HELD: ReadonlySet<ExtensionHostEvent['type']> = new Set(['link', 'command', 'notificationClicked']);
export function hostEventHub() {
  const listeners = new Map<ExtensionHostEvent['type'], Set<(event: ExtensionHostEvent) => void>>();
  const held: ExtensionHostEvent[] = [];
  return {
    deliver(event: ExtensionHostEvent) {
      const set = listeners.get(event.type);
      if (HELD.has(event.type) && !set?.size) {
        held.push(event);
        if (held.length > 20) held.shift();
        return;
      }
      for (const handler of set ?? []) handler(event);
    },
    on(type: ExtensionHostEvent['type'], handler: (event: ExtensionHostEvent) => void): () => void {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
      for (let i = 0; i < held.length; ) {
        if (held[i]!.type === type) handler(held.splice(i, 1)[0]!);
        else i += 1;
      }
      return () => set.delete(handler);
    },
  };
}

/**
 * The members a host has, built from the rows: a call or an event this caller has (`only`) and this host answers
 * (`offers`). A host leaves out what it has not (`typeof gugu.x`), so none of them stands there refusing.
 */
export function hostMembers(
  caller: HostCaller,
  offers: (member: HostMember) => boolean,
  call: (verb: string, args: unknown) => Promise<unknown>,
  on: (type: ExtensionHostEvent['type'], handler: (event: ExtensionHostEvent) => void) => () => void,
): Record<string, unknown> {
  const members: Record<string, unknown> = {};
  const put = (member: string, value: unknown) => {
    const [head, tail] = member.split('.') as [string, string | undefined];
    if (tail === undefined) members[head] = value;
    else members[head] = { ...(members[head] as Record<string, unknown> | undefined), [tail]: value };
  };
  const has = (only: HostCaller | undefined) => only === undefined || only === caller;
  for (const [member, row] of Object.entries(HOST_CALLS) as [HostMember, HostCall][]) {
    if (!offers(member) || !has(verbFacts(row.verb)?.only)) continue;
    const pack = (row.pack ?? same) as (...args: unknown[]) => unknown;
    put(member, (...args: unknown[]) => call(row.verb, pack(...args)));
  }
  for (const [member, row] of Object.entries(HOST_EVENTS) as [HostMember, HostEvent][]) {
    if (!offers(member) || !has(row.only)) continue;
    const pick = row.pick as (event: ExtensionHostEvent) => unknown[];
    put(member, (handler: (...values: unknown[]) => void) => on(row.event, (event) => handler(...pick(event))));
  }
  return members;
}
