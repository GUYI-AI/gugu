import { useHotkeyRecorder, type Hotkey } from '@tanstack/react-hotkeys';
import { useStableHandler } from '@/hooks/useStableHandler';
import { QUICK_CHAT_CHANNELS } from '@/lib/quickChatIpc';
import { rendererLogger } from '@/lib/log';
import { desktopIpc } from '@/platform/desktopIpc';
import { RotateCcw, X } from '@/lib/icons'
import React, { useEffect, useState } from 'react';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { commandCategoryLabel, commandDescription, commandLabel } from '@renderer/lib/commands/command-copy';
import { useAppSettingsKey, type AppSettingsKeyApi } from '@renderer/features/settings/use-app-settings-key';
import type { AppSettings } from '@shared/core/app-settings';
import { SHORTCUTS_BY_CATEGORY } from '@shared/commands';
import { defaultShortcutOwner, shortcutConflict } from '@shared/effective-hotkey';
import { SettingValue } from './SettingControls';
import { toast } from '@renderer/lib/hooks/use-toast';
import {
  getEffectiveHotkey,
  type CommandId,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { Button } from '@renderer/lib/ui/button';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { describeHotkey } from '@renderer/lib/ui/shortcut-format';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { terminalShown, useTerminalEnabled } from '../use-terminal-enabled';

/** 只对终端起作用的快捷键:「终端」开关关着时不列(终端整个不出现,它们也就无事可做)。 */
const TERMINAL_SHORTCUTS: ReadonlySet<CommandId> = new Set<CommandId>(['session.newTerminal', 'session.viewTerminals']);

const KeyboardSettingsCard: React.FC = () => {
  const api = useAppSettingsKey('keyboard');
  return (
    <SettingValue reading={api.settings} placeholder="h-64 w-full">
      {({ value }) => <KeyboardSettingsForm keyboard={value} api={api} />}
    </SettingValue>
  );
};

const KeyboardSettingsForm: React.FC<{ keyboard: AppSettings['keyboard']; api: AppSettingsKeyApi<'keyboard'> }> = ({ keyboard, api }) => {
  const terminalEnabled = terminalShown(useTerminalEnabled());
  const { update, isSaving: saving, resetField } = api;
  const { translate } = useSessionMessages();

  const [editingKey, setEditingKey] = useState<CommandId | null>(null);

  const rejectConflict = (owner: CommandId) => {
    toast({
      title: translate('keyboard.conflictTitle'),
      description: translate('keyboard.conflictDescription', { label: commandLabel(owner) }),
      variant: 'destructive',
    });
    recorder.cancelRecording();
    setEditingKey(null);
  };

  const recorder = useHotkeyRecorder({
    onRecord: (hotkey: Hotkey) => {
      if (!editingKey) return;

      const conflictKey = shortcutConflict(editingKey, hotkey, keyboard);
      if (conflictKey) {
        rejectConflict(conflictKey);
        return;
      }

      update({ [editingKey]: hotkey });
      toast({
        title: translate('keyboard.updatedTitle'),
        description: translate('keyboard.updatedDescription', {
          label: commandLabel(editingKey),
          hotkey: describeHotkey(hotkey),
        }),
      });
      setEditingKey(null);
    },
    onCancel: () => setEditingKey(null),
  });

  const startCapture = (key: CommandId) => {
    setEditingKey(key);
    recorder.startRecording();
  };

  useEffect(() => {
    if (!recorder.isRecording) return;
    return commandRegistry.pauseShortcuts();
  }, [recorder.isRecording]);

  const rejectSystemShortcut = useStableHandler(() => rejectConflict('app.quickChat'));
  useEffect(() => {
    if (!recorder.isRecording) return;
    const ipc = desktopIpc();
    if (!ipc) return;
    const off = ipc.eventOn(QUICK_CHAT_CHANNELS.shortcutRecorded, rejectSystemShortcut);
    const setRecording = (active: boolean) => {
      void ipc.invoke(QUICK_CHAT_CHANNELS.recordShortcut, active).catch(error =>
        rendererLogger('keyboard-settings').warn({ error: String(error) }, 'Could not update native shortcut recording'));
    };
    setRecording(true);
    return () => { off(); setRecording(false); };
  }, [recorder.isRecording, rejectSystemShortcut]);

  const handleReset = (key: CommandId) => {
    const owner = defaultShortcutOwner(key, keyboard);
    resetField(key);
    toast({
      title: translate('keyboard.resetTitle'),
      description: owner ? translate('keyboard.defaultInUse', { label: commandLabel(owner) })
        : translate('keyboard.resetDescription', { label: commandLabel(key) }),
    });
  };

  const handleClear = (key: CommandId) => {
    update({ [key]: null });
    toast({
      title: translate('keyboard.removedTitle'),
      description: translate('keyboard.removedDescription', { label: commandLabel(key) }),
    });
  };

  return (
    <div className="gg-settings-surface p-4">
      <div className="space-y-6">
        {[...SHORTCUTS_BY_CATEGORY]
          .map(([category, shortcuts]) => [category, shortcuts.filter(([key]) => terminalEnabled || !TERMINAL_SHORTCUTS.has(key))] as const)
          .filter(([, shortcuts]) => shortcuts.length > 0)
          .map(([category, shortcuts]) => (
          <div key={category}>
            <div className="text-foreground-muted mb-3 text-xs font-medium tracking-wide uppercase">
              {commandCategoryLabel(category)}
            </div>
            <div className="space-y-3">
              {shortcuts.map(([key]) => {
                const effectiveHotkey = getEffectiveHotkey(key, keyboard);
                const displacedBy = keyboard[key] === undefined && defaultShortcutOwner(key, keyboard);
                const capturing = editingKey === key && recorder.isRecording;
                const showClear = effectiveHotkey !== null;
                const showReset = keyboard[key] !== undefined;
                const showActions = showClear || showReset;

                return (
                  <div
                    key={key}
                    data-command-id={key}
                    className="group/shortcut flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-2"
                  >
                    <div className="min-w-0 flex-1 basis-64 space-y-1">
                      <div className="text-sm break-words">{commandLabel(key)}</div>
                      <div className="text-foreground-muted text-xs break-words">
                        {commandDescription(key)}
                        {displacedBy && <p>{translate('keyboard.defaultInUse', { label: commandLabel(displacedBy) })}</p>}
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      {capturing ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-w-[80px] animate-pulse"
                            onClick={() => recorder.cancelRecording()}
                            disabled={saving}
                          >
                            {translate('keyboard.pressKeys')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => recorder.cancelRecording()}
                            disabled={saving}
                          >
                            {translate('common.cancel')}
                          </Button>
                        </>
                      ) : (
                        <>
                          {showActions && (
                            <div className="pointer-events-none flex items-center gap-1 opacity-0 transition-opacity group-hover/shortcut:pointer-events-auto group-hover/shortcut:opacity-100">
                              <TooltipProvider delay={150}>
                                {showReset && (
                                  <Tooltip>
                                    <TooltipTrigger render={<span className="inline-flex" />}>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="text-foreground-muted hover:text-foreground"
                                        onClick={() => handleReset(key)}
                                        disabled={saving}
                                        aria-label={translate('reset.toDefault')}
                                      >
                                        <RotateCcw className="h-3.5 w-3.5" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      {translate('reset.toDefault')}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                                {showClear && (
                                  <Tooltip>
                                    <TooltipTrigger render={<span className="inline-flex" />}>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="text-foreground-muted hover:text-foreground"
                                        onClick={() => handleClear(key)}
                                        disabled={saving}
                                        aria-label={translate('keyboard.removeShortcut')}
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      {translate('keyboard.removeShortcut')}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </TooltipProvider>
                            </div>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="min-w-[80px] justify-end px-0 hover:bg-transparent dark:hover:bg-transparent"
                            onClick={() => startCapture(key)}
                            disabled={saving}
                          >
                            {effectiveHotkey ? <Shortcut hotkey={effectiveHotkey} variant="keycaps" /> : translate('keyboard.unassignedValue')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default KeyboardSettingsCard;
