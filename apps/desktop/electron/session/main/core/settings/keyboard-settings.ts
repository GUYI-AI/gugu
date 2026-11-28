import { EventEmitter } from 'node:events';
import type { AppSettings } from '@shared/core/app-settings';
import { browserWebContentsRegistry } from '@main/core/browser/browser-webcontents-registry';

const changes = new EventEmitter<{ keyboard: [AppSettings['keyboard']] }>();

/** The host menu subscribes before session startup loads the saved settings. */
export function onKeyboardSettingsChanged(listener: (keyboard: AppSettings['keyboard']) => void): void {
  changes.on('keyboard', listener);
}

export function applyKeyboardSettings(keyboard: AppSettings['keyboard']): void {
  browserWebContentsRegistry.setKeyboardSettings(keyboard);
  changes.emit('keyboard', keyboard);
}
