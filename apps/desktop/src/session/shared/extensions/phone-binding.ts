import type { AssistantScreen } from './assistant-binding';

/**
 * API 49: the conversation binding (#1927) on a phone. Until 48 a binding of any action made the App desktop-only
 * (#1995: the binding store and its picker were the desktop main process's). From 49 an App listing `phone` may declare it;
 * the phone answers the same calls with the same authority — the signed-in account, the App as installed on this phone,
 * the conversation, all asked again after every wait — and says, in a closed answer, what has no meaning on a phone.
 *
 * A phone has no picker. The one binding a phone makes is the host's own: the product's assistant App (assistant-entry.ts),
 * bound to the account's private chat with its own assistant. Any other App's binding is `unbound` on a phone.
 */
export const PHONE_BINDING_API_VERSION = 49;

/**
 * The phone's assistant layer (`MobileAssistantApp`): the host draws its tabs — 聊天 (the conversation, the host's own), then
 * 动态 / 任务 / 记忆, and 资料 behind the assistant's face — and the App's main page fills every section but the
 * conversation, full screen under the host's header, inside the safe areas. The page is told which (`section`) and draws
 * that section's phone layout, with no tab row of its own.
 */
export const PHONE_SURFACE_SECTIONS = ['today', 'tasks', 'memory', 'profile'] as const;
export type PhoneSurfaceSection = (typeof PHONE_SURFACE_SECTIONS)[number];

/**
 * What a binding call answers on a device where it means nothing (a phone: no panel beside the conversation to collapse,
 * no home to move to, setup steps a computer draws). Closed: not an error, and asking again answers the same.
 */
export type AppBindingUnsupported = { name: string; state: 'unsupported' };
export const unsupportedHere = (name: string): AppBindingUnsupported => ({ name, state: 'unsupported' });

/**
 * `gugu.assistant.open(name, screen)` on a phone: each screen opens the phone's own existing screen for it — or, `null`,
 * there is none (`unsupported`). Setup and settings are the assistant's settings page (a phone sets an assistant up only in
 * the cloud, from the layer itself; settings is also the built-in panel's gear, #1925); look is the look workshop (换形象, the page 自定义's button opens — never 自定义 itself,
 * the App draws its own); model the model page of its settings; devices, connected apps, projects (项目) and capabilities
 * (能力) their pages under 资料; health the phone's own 健康 page under 记忆 (Health Connect, read on the phone, never handed to
 * the App); close the one close confirmation. A phone cannot be the assistant's home: moving it is a computer's.
 */
export const PHONE_ASSISTANT_SCREENS = {
  setup: { section: 'profile', page: 'settings' },
  move: null,
  close: { confirm: 'close' },
  look: { section: 'profile', page: 'look' },
  model: { section: 'profile', page: 'settings:aimodel' },
  devices: { section: 'profile', page: 'devices' },
  'connected-apps': { connectors: true },
  health: { section: 'memory', page: 'health' },
  settings: { section: 'profile', page: 'settings' },
  projects: { section: 'profile', page: 'library:workspace' },
  capabilities: { section: 'profile', page: 'library:capabilities' },
} as const satisfies Record<AssistantScreen, { section: PhoneSurfaceSection; page: string } | { confirm: 'close' } | { connectors: true } | null>;
export type PhoneAssistantScreen = Exclude<(typeof PHONE_ASSISTANT_SCREENS)[AssistantScreen], null>;

/** Which calls have no phone meaning, said once: the authoring guide and the phone host read this. */
export const PHONE_UNSUPPORTED = {
  /** `bindings.setPanel(name, { collapsed })`: no panel beside the conversation; `{ section }` moves the layer instead. */
  setPanelCollapsed: true,
  /** `assistant.open(name, "move")`: a phone is never the assistant's home. */
  openMove: true,
  /** `assistant.advanceSetup`: the steps after the home (connect → ready) are drawn on a computer. */
  advanceSetup: true,
  /** `contributes.unreadSource`: the phone has no App rail; the conversation's own row in 消息 carries its unread. */
  unreadSource: true,
} as const;
