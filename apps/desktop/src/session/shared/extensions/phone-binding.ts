import type { AssistantScreen } from './assistant-binding';

/**
 * API 48: the conversation binding (#1927) on a phone. Until 47 a binding of any action made the App desktop-only
 * (#1995: the binding store and its picker were the desktop main process's). From 48 an App listing `phone` may declare it;
 * the phone answers the same calls with the same authority — the signed-in account, the App as installed on this phone,
 * the conversation, all asked again after every wait — and says, in a closed answer, what has no meaning on a phone.
 *
 * A phone has no picker. The one binding a phone makes is the host's own: the product's assistant App (assistant-entry.ts),
 * bound to the account's private chat with its own assistant. Any other App's binding is `unbound` on a phone.
 */
export const PHONE_BINDING_API_VERSION = 48;

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
 * there is none (`unsupported`). Setup is the assistant's settings page (a phone sets an assistant up only in the cloud,
 * from the layer itself); look is its customize page; model the model page of its settings; devices and connected apps
 * their pages under 资料; close the one close confirmation. A phone cannot be the assistant's home: moving it is a
 * computer's.
 */
export const PHONE_ASSISTANT_SCREENS = {
  setup: { section: 'profile', page: 'settings' },
  move: null,
  close: { confirm: 'close' },
  look: { section: 'profile', page: 'customize' },
  model: { section: 'profile', page: 'settings:aimodel' },
  devices: { section: 'profile', page: 'devices' },
  'connected-apps': { connectors: true },
} as const satisfies Record<AssistantScreen, { section: 'profile'; page: string } | { confirm: 'close' } | { connectors: true } | null>;
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
