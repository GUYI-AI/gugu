/**
 * One settings row to bring into view when the settings open on its page (an action like Auto mode's
 * "choose a review model"). The row takes it when it mounts, or at once if its page is already open.
 */
export type SettingsFocusAnchor = 'review-model';

const SETTINGS_FOCUS_EVENT = 'gugu:settings-focus';
let pending: SettingsFocusAnchor | null = null;

export function requestSettingsFocus(anchor: SettingsFocusAnchor | null): void {
  pending = anchor;
  if (anchor) window.dispatchEvent(new CustomEvent(SETTINGS_FOCUS_EVENT));
}

/** Call from the row: runs `focus` now if this anchor is pending, and on every later request; returns the cleanup. */
export function followSettingsFocus(anchor: SettingsFocusAnchor, focus: () => void): () => void {
  const take = () => {
    if (pending !== anchor) return;
    pending = null;
    focus();
  };
  take();
  window.addEventListener(SETTINGS_FOCUS_EVENT, take);
  return () => window.removeEventListener(SETTINGS_FOCUS_EVENT, take);
}
