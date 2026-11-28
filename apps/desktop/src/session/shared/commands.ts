import { sessionActionDefault, type ShortcutPlatform } from './shortcuts';

export const COMMAND_CATEGORIES = ['Create', 'Navigation', 'Current Conversation', 'View', 'Tab Navigation', 'Git', 'Browser', 'Apps', 'Diagnostics'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export type CommandAlias = string | { character: string; region: 'navigation' };

/** The single catalog for built-in command labels and key bindings. */
export interface CommandDef {
  id: string;
  /** English name. Shown words come from the session catalog: `labelKey` (a menu's own name) or `command.<id>`. */
  label: string;
  labelKey?: string;
  /** English help text; shown words come from `commandHelp.<id>`. */
  description: string;
  iconKey?: string;
  category: CommandCategory;
  defaultHotkey?: string | ((platform: ShortcutPlatform) => string);
  /** Aliases stay bound when the primary key changes. Clearing the command disables its aliases too. */
  aliases?: readonly CommandAlias[];
  /** The operating system registers this shortcut through its own preference. */
  systemShortcut?: boolean;
  hideFromSettings?: boolean;
  hideFromPalette?: boolean;
  ignoreInputs?: boolean;
  /** Capture before terminal widgets and modal roots consume global entry keys. */
  capture?: boolean;
  conflictBehavior?: 'prevent' | 'allow';
  ignoreWhenCodeEditorFocused?: boolean;
  ignoreWhenBrowserFocused?: boolean;
  /**
   * While the shell shows another tab the task page stays mounted but hidden, and its commands stand down. A command
   * that is still the user's intent from there says so: 'run' = it acts on the shell itself; 'reveal' = bring the
   * task page forward, then run it there. Unset = it only means something on the task page.
   */
  whenSessionPageHidden?: 'run' | 'reveal';
}

/** Whether a command is named by a menu's own words (`labelKey`) is kept in its type, so the copy catalog can tell. */
type CommandEntry<K, D> = CommandDef & { id: K } & (D extends { labelKey: infer L extends string } ? { labelKey: L } : { labelKey?: undefined });

function defineCommands<const T extends Record<string, Omit<CommandDef, 'id'>>>(defs: T) {
  return Object.fromEntries(Object.entries(defs).map(([id, def]) => [id, { ...def, id }])) as {
    [K in keyof T]: CommandEntry<K, T[K]>;
  };
}

export const COMMANDS = defineCommands({
  'app.quickChat': {
    systemShortcut: true,
    whenSessionPageHidden: 'run',
    label: 'Quick Chat', description: 'Open the floating assistant chat', category: 'Create',
  },
  'app.focusNextPane': {
    label: 'Focus Next Pane', description: 'Move focus forward between the sidebar, conversation and composer',
    category: 'View', defaultHotkey: 'F6', hideFromPalette: true, ignoreInputs: false,
  },
  'app.focusPreviousPane': {
    label: 'Focus Previous Pane', description: 'Move focus backward between the sidebar, conversation and composer',
    category: 'View', defaultHotkey: 'Shift+F6', hideFromPalette: true, ignoreInputs: false,
  },
  'app.settings': {
    whenSessionPageHidden: 'run',
    label: 'Open Settings',
    labelKey: 'appSettings.settings',
    description: 'Open application settings',
    iconKey: 'settings',
    defaultHotkey: 'Mod+,',
    category: 'Navigation',
  },
  // Preserve existing custom bindings for the shortcut to this area.
  'app.library': {
    whenSessionPageHidden: 'reveal',
    label: 'Open Marketplace',
    labelKey: 'extensions.tabMarket',
    description: 'Open the Marketplace',
    iconKey: 'library',
    category: 'Apps',
  },
  'app.newProject': {
    whenSessionPageHidden: 'reveal',
    label: 'New Project',
    labelKey: 'sidebar.addProject',
    description: 'Add a new local or SSH project',
    iconKey: 'folder-plus',
    category: 'Create',
  },
  'app.newSession': {
    whenSessionPageHidden: 'reveal',
    label: 'New Task',
    labelKey: 'sidebar.newTask',
    description: 'Create a new task in this project',
    iconKey: 'bolt',
    defaultHotkey: 'Mod+N',
    category: 'Create',
  },
  'app.sessionHistory': {
    whenSessionPageHidden: 'reveal',
    label: 'Task history',
    labelKey: 'sidebar.sessionHistory',
    description: 'View Gugu tasks and local Claude Code / Codex sessions in one list: open them, restore archived ones, or import ones not yet imported',
    iconKey: 'history',
    category: 'Navigation',
  },
  'app.newGroupChat': {
    defaultHotkey: 'Mod+Shift+N',
    whenSessionPageHidden: 'run',
    label: 'New group chat',
    labelKey: 'sidebar.newGroupChat',
    description: 'Create a group chat',
    iconKey: 'users',
    category: 'Create',
  },
  'app.addContact': {
    whenSessionPageHidden: 'run',
    label: 'Add contact',
    labelKey: 'sidebar.addContact',
    description: 'Add a contact',
    iconKey: 'user-plus',
    category: 'Create',
  },
  'chat.newDirect': {
    label: 'New Direct Message',
    description: 'Choose a contact to message',
    category: 'Create',
  },
  'chat.markAllRead': {
    label: 'Mark All as Read',
    description: 'Mark all conversations as read',
    category: 'Navigation',
    defaultHotkey: 'Shift+Escape',
  },
  'session.switchModel': {
    label: 'Switch Model',
    description: 'Choose a model for the focused composer',
    category: 'Current Conversation',
    defaultHotkey: 'Mod+Shift+M',
  },
  'app.scheduled': {
    whenSessionPageHidden: 'reveal',
    label: 'Scheduled',
    labelKey: 'sidebar.scheduled',
    description: 'Open the scheduled tasks',
    iconKey: 'clock',
    category: 'Navigation',
  },
  'app.giveFeedback': {
    whenSessionPageHidden: 'run',
    label: 'Give Feedback',
    labelKey: 'main:shell.feedback',
    description: 'Send feedback to the Gugu team',
    iconKey: 'message-square-share',
    category: 'Diagnostics',
  },
  'app.toggleTheme': {
    whenSessionPageHidden: 'run',
    label: 'Toggle Theme',
    description: 'Switch between light and dark themes',
    iconKey: 'palette',
    category: 'View',
  },
  'app.navigateBack': {
    hideFromPalette: true,
    label: 'Go Back',
    description: 'Navigate to the previous location',
    iconKey: 'arrow-left',
    defaultHotkey: 'Mod+[',
    category: 'Navigation',
  },
  'app.navigateForward': {
    hideFromPalette: true,
    label: 'Go Forward',
    description: 'Navigate to the next location',
    iconKey: 'arrow-right',
    defaultHotkey: 'Mod+]',
    category: 'Navigation',
  },
  'app.showKeyboardShortcuts': {
    aliases: [{ character: '?', region: 'navigation' }],
    whenSessionPageHidden: 'reveal',
    label: 'Keyboard Shortcuts',
    description: 'Show the keyboard shortcuts cheat sheet',
    iconKey: 'keyboard',
    defaultHotkey: 'Mod+/',
    category: 'Navigation',
  },
  'session.sideSession': {
    label: 'Side Chat',
    description: 'Fork the current task into a temporary side chat',
    iconKey: 'message-square-plus',
    category: 'Current Conversation',
  },
  'session.sidebarChanges': {
    label: 'View Changes',
    description: 'Open the Review tab in the file panel',
    iconKey: 'file-diff',
    defaultHotkey: 'Mod+Shift+1',
    category: 'Current Conversation',
  },
  'session.sidebarFiles': {
    label: 'View Files',
    description: 'Open the Files tab in the file panel',
    iconKey: 'folder-open',
    defaultHotkey: 'Mod+Shift+2',
    category: 'Current Conversation',
  },
  'session.viewTerminals': {
    label: 'View Terminals',
    description: 'Open the terminal drawer',
    iconKey: 'terminal',
    category: 'Current Conversation',
  },
  'session.newTerminal': {
    label: 'New Terminal',
    description: 'Create a new terminal session',
    iconKey: 'square-terminal',
    defaultHotkey: 'Mod+Shift+`',
    category: 'Create',
  },
  'session.openBrowser': {
    label: 'Open Browser',
    description: 'Open an in-app browser for this task',
    iconKey: 'globe',
    defaultHotkey: 'Mod+Shift+B',
    category: 'Browser',
  },
  'session.browserGoBack': {
    label: 'Browser Back',
    description: 'Go back in the active browser tab',
    iconKey: 'arrow-left',
    category: 'Browser',
  },
  'session.browserGoForward': {
    label: 'Browser Forward',
    description: 'Go forward in the active browser tab',
    iconKey: 'arrow-right',
    category: 'Browser',
  },
  'session.browserReload': {
    label: 'Reload Browser',
    description: 'Reload the active browser tab',
    iconKey: 'refresh-cw',
    category: 'Browser',
  },
  'session.browserFocusUrl': {
    defaultHotkey: 'Mod+L',
    label: 'Focus Browser URL',
    description: 'Focus the URL field in the active browser tab',
    iconKey: 'text-cursor-input',
    category: 'Browser',
  },
  'session.browserOpenExternal': {
    label: 'Open Browser URL Externally',
    description: 'Open the active browser URL in the system browser',
    iconKey: 'external-link',
    category: 'Browser',
  },
  'session.browserCopyUrl': {
    label: 'Copy Browser URL',
    description: 'Copy the active browser URL',
    iconKey: 'copy',
    defaultHotkey: 'Mod+Shift+C',
    category: 'Browser',
  },
  'session.gitFetch': {
    label: 'Git Fetch',
    description: 'Fetch latest changes from remote',
    iconKey: 'git-pull-request',
    category: 'Git',
  },
  'session.gitPull': {
    label: 'Git Pull',
    description: 'Pull latest changes from remote',
    iconKey: 'arrow-down-to-line',
    category: 'Git',
  },
  'session.gitPush': {
    label: 'Git Push',
    description: 'Push commits to remote',
    iconKey: 'arrow-up-to-line',
    category: 'Git',
  },
  'task.pin': {
    label: 'Pin',
    description: 'Pin this task to keep it at the top',
    iconKey: 'pin',
    category: 'Current Conversation',
  },
  'task.archive': {
    label: 'Archive session',
    labelKey: 'task.archiveTaskTitle',
    description: 'Archive the current task',
    iconKey: 'archive',
    defaultHotkey: 'Mod+Shift+E',
    category: 'Current Conversation',
    ignoreWhenCodeEditorFocused: true,
  },
  'session.focusSidebar': {
    label: 'Focus Sidebar',
    description: 'Move focus to the left sidebar',
    iconKey: 'panel-left',
    category: 'Navigation',
  },
  'session.focusComposer': {
    label: 'Focus Composer',
    description: 'Focus the message composer input',
    iconKey: 'text-cursor-input',
    category: 'Current Conversation',
    ignoreWhenCodeEditorFocused: true,
  },
  'session.addContext': {
    label: 'Add Context',
    description: 'Open the context picker for the active task',
    iconKey: 'list-plus',
    defaultHotkey: 'Mod+Shift+A',
    category: 'Current Conversation',
    ignoreWhenCodeEditorFocused: true,
  },
  'session.stageAll': {
    label: 'Stage All Files',
    description: 'Stage all unstaged files',
    iconKey: 'git-commit',
    defaultHotkey: 'Mod+Shift+G',
    category: 'Git',
    ignoreWhenCodeEditorFocused: true,
  },
  'session.timelineNext': {
    label: 'Next Timeline Entry',
    description: 'Jump to the next timeline entry',
    iconKey: 'chevron-down',
    defaultHotkey: 'Alt+]',
    category: 'Current Conversation',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.timelinePrev': {
    label: 'Previous Timeline Entry',
    description: 'Jump to the previous timeline entry',
    iconKey: 'chevron-up',
    defaultHotkey: 'Alt+[',
    category: 'Current Conversation',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'app.commandPalette': {
    aliases: ['Mod+P'],
    hideFromPalette: true,
    whenSessionPageHidden: 'reveal',
    capture: true,
    defaultHotkey: 'Mod+Shift+P',
    label: 'Command Palette',
    description: 'Open the command palette to run an available command',
    category: 'Navigation',
  },
  'app.quickSwitcher': {
    aliases: ['Mod+O'],
    hideFromPalette: true,
    whenSessionPageHidden: 'reveal',
    capture: true,
    defaultHotkey: 'Mod+K',
    label: 'Quick Switcher',
    description: 'Switch between tasks, groups, projects, and contacts',
    category: 'Navigation',
  },
  'app.globalSearch': {
    whenSessionPageHidden: 'reveal',
    capture: true,
    defaultHotkey: 'Mod+Shift+F',
    label: 'Search Messages',
    description: 'Search what was said in every chat and task',
    category: 'Navigation',
  },
  'app.toggleLeftSidebar': {
    defaultHotkey: 'Mod+Shift+S',
    label: 'Toggle Left Sidebar',
    description: 'Show or hide the left sidebar',
    category: 'View',
  },
  'app.zenMode': {
    defaultHotkey: platform => platform === 'mac' ? 'Control+Z' : 'Control+Shift+\\',
    label: 'Zen Mode',
    description: 'Hide both sidebars',
    category: 'View',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
    ignoreInputs: true,
  },
  'app.closeModal': {
    hideFromPalette: true,
    defaultHotkey: 'Escape',
    label: 'Close Modal',
    description: 'Close the current modal or dialog',
    category: 'Navigation',
    hideFromSettings: true,
  },
  'session.tabNext': {
    hideFromPalette: true,
    aliases: ['Control+Tab'],
    defaultHotkey: 'Mod+Alt+ArrowRight',
    label: 'Next Tab',
    description: 'Switch to the next tab',
    category: 'Tab Navigation',
  },
  'session.tabPrev': {
    hideFromPalette: true,
    aliases: ['Control+Shift+Tab'],
    defaultHotkey: 'Mod+Alt+ArrowLeft',
    label: 'Previous Tab',
    description: 'Switch to the previous tab',
    category: 'Tab Navigation',
  },
  'session.tabClose': {
    defaultHotkey: 'Mod+W',
    label: 'Close Tab',
    description: 'Close the active tab',
    category: 'Tab Navigation',
  },
  'session.tabReopen': {
    defaultHotkey: 'Mod+Shift+T',
    label: 'Reopen Closed Tab',
    description: 'Reopen the most recently closed tab',
    category: 'Tab Navigation',
  },
  'session.tabRename': {
    defaultHotkey: 'Mod+Shift+R',
    label: 'Rename Tab',
    description: 'Rename the active tab (when supported)',
    category: 'Tab Navigation',
  },
  'session.openAddMenu': {
    defaultHotkey: 'Mod+T',
    label: 'New Tab',
    description: 'Open the + menu of the focused pane',
    category: 'Tab Navigation',
  },
  'app.confirm': {
    hideFromPalette: true,
    defaultHotkey: 'Mod+Enter',
    label: 'Confirm',
    description: 'Confirm the current dialog action',
    category: 'Navigation',
  },
  'session.splitPane': {
    defaultHotkey: 'Mod+\\',
    label: 'Split Pane',
    description: 'Show the active tab side by side with the last one, or separate the pair',
    category: 'Tab Navigation',
  },
  'session.fullscreenTab': {
    defaultHotkey: 'Mod+Shift+Enter',
    label: 'Full Screen Tab',
    description: 'Let the active tab cover the whole workspace for now, or leave full screen (the layout stays as it is)',
    category: 'Tab Navigation',
  },
  'session.next': {
    hideFromPalette: true,
    defaultHotkey: 'Mod+ArrowDown',
    label: 'Next Task',
    description: 'Move to the next task in the sidebar and show it',
    category: 'Navigation',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.previous': {
    hideFromPalette: true,
    defaultHotkey: 'Mod+ArrowUp',
    label: 'Previous Task',
    description: 'Move to the previous task in the sidebar and show it',
    category: 'Navigation',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.focusComposerFromSidebar': {
    hideFromPalette: true,
    defaultHotkey: 'ArrowRight',
    label: 'Focus Composer From Sidebar',
    description: 'Hand the keyboard back to the composer',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.projectHome': {
    defaultHotkey: 'ArrowLeft',
    label: 'Project Home',
    description: "Jump to the parent project's home, where a new task is started",
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.backToList': {
    hideFromPalette: true,
    defaultHotkey: 'ArrowLeft',
    label: 'Back To Task List',
    description: 'Leave the composer for the sidebar when the caret is at the start',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.leaveTerminal': {
    hideFromPalette: true,
    defaultHotkey: 'Alt+ArrowLeft',
    label: 'Leave Terminal For Task List',
    description: 'Hand the keyboard from a terminal task back to the sidebar',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.leaveComposer': {
    hideFromPalette: true,
    defaultHotkey: 'Escape',
    label: 'Leave Composer',
    description: 'Return from the composer to sidebar navigation, keeping the draft',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.rename': {
    defaultHotkey: (platform) => sessionActionDefault('R', platform),
    label: 'Rename',
    labelKey: 'task.rename',
    description: 'Rename the highlighted task in place',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.pinHighlighted': {
    defaultHotkey: (platform) => sessionActionDefault('P', platform),
    label: 'Pin Task',
    description: 'Pin or unpin the highlighted task',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'session.archiveHighlighted': {
    defaultHotkey: (platform) => sessionActionDefault('X', platform),
    label: 'Archive Highlighted Task',
    description: 'Archive the highlighted task (press twice to confirm)',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'app.find': {
    hideFromPalette: true,
    capture: true,
    label: 'Find in Current View',
    description: 'Search the focused terminal or chat',
    category: 'Navigation',
    defaultHotkey: 'Mod+F',
    ignoreWhenCodeEditorFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  'chat.rename': {
    label: 'Rename Group',
    description: 'Rename the focused group',
    category: 'Navigation',
  },
  'app.resourceMonitor': {
    whenSessionPageHidden: 'run',
    label: 'Resource Monitor',
    labelKey: 'palette.resourceMonitor',
    description: 'View application resource usage',
    category: 'Navigation',
  },
  'session.tab1': {
    hideFromPalette: true,
    label: 'Go to Tab 1',
    description: 'Switch to tab 1',
    category: 'Tab Navigation',
  },
  'session.tab2': {
    hideFromPalette: true,
    label: 'Go to Tab 2',
    description: 'Switch to tab 2',
    category: 'Tab Navigation',
  },
  'session.tab3': {
    hideFromPalette: true,
    label: 'Go to Tab 3',
    description: 'Switch to tab 3',
    category: 'Tab Navigation',
  },
  'session.tab4': {
    hideFromPalette: true,
    label: 'Go to Tab 4',
    description: 'Switch to tab 4',
    category: 'Tab Navigation',
  },
  'session.tab5': {
    hideFromPalette: true,
    label: 'Go to Tab 5',
    description: 'Switch to tab 5',
    category: 'Tab Navigation',
  },
  'session.tab6': {
    hideFromPalette: true,
    label: 'Go to Tab 6',
    description: 'Switch to tab 6',
    category: 'Tab Navigation',
  },
  'session.tab7': {
    hideFromPalette: true,
    label: 'Go to Tab 7',
    description: 'Switch to tab 7',
    category: 'Tab Navigation',
  },
  'session.tab8': {
    hideFromPalette: true,
    label: 'Go to Tab 8',
    description: 'Switch to tab 8',
    category: 'Tab Navigation',
  },
  'session.tab9': {
    hideFromPalette: true,
    label: 'Go to Tab 9',
    description: 'Switch to tab 9',
    category: 'Tab Navigation',
  },
  'chat.nextUnread': {
    label: 'Next Unread Conversation',
    description: 'Open the next unread conversation in the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+Shift+ArrowDown',
  },
  'chat.previousUnread': {
    label: 'Previous Unread Conversation',
    description: 'Open the previous unread conversation in the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+Shift+ArrowUp',
  },
  'chat.scrollToTop': {
    label: 'Scroll to Top',
    description: 'Scroll the focused conversation to its first message',
    category: 'Current Conversation',
  },
  'chat.scrollToBottom': {
    defaultHotkey: 'Mod+J',
    label: 'Jump to Latest',
    description: 'Scroll the focused conversation to its latest message',
    category: 'Current Conversation',
  },
  'app.closeWindow': {
    hideFromPalette: true,
    defaultHotkey: 'Mod+W',
    label: 'Close Window',
    description: 'Close this window when no tab has the focus',
    category: 'Navigation',
    whenSessionPageHidden: 'run',
    ignoreWhenBrowserFocused: true,
  },
  'app.goMessages': {
    defaultHotkey: 'Mod+Alt+1',
    label: 'Go to Messages',
    description: 'Show the messages tab',
    category: 'Navigation',
    whenSessionPageHidden: 'run',
  },
  'app.goContacts': {
    defaultHotkey: 'Mod+Alt+2',
    label: 'Go to Contacts',
    description: 'Show the contacts tab',
    category: 'Navigation',
    whenSessionPageHidden: 'run',
  },
  'chat.select1': {
    hideFromPalette: true,
    label: 'Open Conversation 1',
    description: 'Open the conversation in position 1 of the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+1',
  },
  'chat.select2': {
    hideFromPalette: true,
    label: 'Open Conversation 2',
    description: 'Open the conversation in position 2 of the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+2',
  },
  'chat.select3': {
    hideFromPalette: true,
    label: 'Open Conversation 3',
    description: 'Open the conversation in position 3 of the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+3',
  },
  'chat.select4': {
    hideFromPalette: true,
    label: 'Open Conversation 4',
    description: 'Open the conversation in position 4 of the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+4',
  },
  'chat.select5': {
    hideFromPalette: true,
    label: 'Open Conversation 5',
    description: 'Open the conversation in position 5 of the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+5',
  },
  'chat.select6': {
    hideFromPalette: true,
    label: 'Open Conversation 6',
    description: 'Open the conversation in position 6 of the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+6',
  },
  'chat.select7': {
    hideFromPalette: true,
    label: 'Open Conversation 7',
    description: 'Open the conversation in position 7 of the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+7',
  },
  'chat.select8': {
    hideFromPalette: true,
    label: 'Open Conversation 8',
    description: 'Open the conversation in position 8 of the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+8',
  },
  'chat.select9': {
    hideFromPalette: true,
    label: 'Open Conversation 9',
    description: 'Open the conversation in position 9 of the list',
    category: 'Navigation',
    defaultHotkey: 'Mod+9',
  },
});

export type CommandId = keyof typeof COMMANDS;

/** Commands whose shown name is a menu's own entry (`labelKey`); every other command is named by `command.<id>`. */
export type MenuNamedCommandId = {
  [K in CommandId]: (typeof COMMANDS)[K] extends { labelKey: string } ? K : never;
}[CommandId];

export const CONFIGURABLE_SHORTCUTS = (
  Object.entries(COMMANDS) as [
    CommandId,
    (typeof COMMANDS)[CommandId],
  ][]
).filter(([, def]) => !def.hideFromSettings && !def.systemShortcut);

export const SHORTCUTS_BY_CATEGORY = CONFIGURABLE_SHORTCUTS.reduce((acc, entry) => {
  const category = entry[1].category;
  acc.set(category, [...(acc.get(category) ?? []), entry]);
  return acc;
}, new Map<CommandCategory, [CommandId, (typeof COMMANDS)[CommandId]][]>(COMMAND_CATEGORIES.map(category => [category, []])));
