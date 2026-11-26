// Q3 (#2301): the connection state of the machine a session runs on, in that session block's own strip — the right end
// of its tab strip, the strip of a tab that went to its own window, and a minimal strip while the session is still
// cold (its tabs are not mounted yet). Each block says its own machine; nothing is said for this computer.
import { observer } from 'mobx-react-lite';
import { type ReactNode, type RefObject, useContext, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ConnectionStatus } from '@/components/connection/ConnectionStatus';
import type { ConnectionState } from '@/components/connection/connectionState';
import { DeviceRecoveryPanel, DeviceRecoveryStatus, type DeviceRecoveryProps } from '@/components/settings/DeviceRecoveryPanel';
import { Popover } from '@/components/ui/Popover';
import { IconButton } from '@/components/ui/IconButton';
import { ChevronRight, X } from '@/lib/icons';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { headerConnectionState } from '@renderer/features/remote-hosts/header-connection-state';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { auxLayerOf } from '@renderer/app/aux-layers';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { useSessionViewContext } from '../session-view-context';
import { TabBarActionRow } from '../titlebar-actions';

export const SessionMachineStatus = observer(function SessionMachineStatus() {
  const { projectId, sessionId } = useSessionViewContext();
  const deviceId = machineRegistry.machineOf(projectId);
  const device = deviceId ? remoteHostsStore.device(deviceId) : null;
  const connection = deviceId ? remoteHostsStore.connectionState(deviceId) : null;
  const { translate } = useSessionMessages();
  if (!device || !deviceId) return null;
  const ssh = !!device.directTerminal && !device.viaTunnel;
  const state = headerConnectionState(connection) ?? (ssh && connection ? 'device_offline' : null);
  if (!state) return null;
  if (ssh) {
    const reason = device.sshLink ?? (connection === 'connected' ? 'connected' : connection === 'connecting' ? 'checking'
      : connection === 'reconnecting' ? 'unreachable' : connection === 'sign-in' || device.signInExpiredAt !== undefined ? 'notSignedIn'
      : connection === 'update-failed' ? 'updateFailed' : connection === 'outdated' || connection === 'updating' ? connection : 'offline');
    const lastSync = connection === 'connected' ? undefined : remoteHostsStore.hosts.get(deviceId)?.lastTaskListAt;
    return <TaskDeviceRecovery key={deviceId} sessionId={sessionId} deviceId={deviceId} name={device.label} state={reason}
      lastSync={lastSync ?? undefined} version={device.version} />;
  }
  const word = connection === 'updating' ? translate('machinePicker.updating') : undefined;
  return <MachineStatusChip state={state} word={word} lastSeenAt={device.lastSeenAt} label={device.label} />;
});

const STATE_WORD_KEY = { online: 'connection.online', connecting: 'connection.connecting', device_offline: 'connection.deviceOffline' } as const;

function TaskDeviceRecovery({ sessionId, ...props }: Omit<DeviceRecoveryProps, 'onDone'> & { sessionId: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const returnToDraft = useRef(false);
  const caret = useRef<Range | null>(null);
  const shown = useContext(SurfaceShownContext);
  useLayoutEffect(() => { if (!shown) setOpen(false); }, [shown]);
  const compact = useCompactWhenTabsSqueezed(ref);
  const { t } = useTranslation('settings');
  function composer() {
    const element = ref.current;
    if (!element) return null;
    const block = element.closest('[data-screen-block]');
    const sameTask = `[data-session-chat-session-id="${CSS.escape(sessionId)}"] [data-testid="prompt-editor"]`;
    return (block ?? element.ownerDocument).querySelector<HTMLElement>(sameTask)
      ?? block?.querySelector<HTMLElement>('[data-region="composer"] [data-testid="prompt-editor"]') ?? null;
  }
  return <span ref={ref} data-slot="session-machine-status" data-compact={compact ? '' : undefined}
    className="window-no-drag-region inline-flex min-w-min items-center text-xs" data-testid="session-machine-status">
    <Popover.Root open={open && shown} onOpenChange={(next, details) => {
      if (next) {
        const doc = ref.current?.ownerDocument;
        if (!doc) return;
        // The task surface sits below window notices. Keep the window's popup container stable through the exit transition.
        setPortal(auxLayerOf(doc) ?? doc.body);
        returnToDraft.current = false;
        const selection = doc.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        caret.current = range && composer()?.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
      } else {
        returnToDraft.current = details.reason === 'escape-key' || details.reason === 'close-press';
      }
      setOpen(next);
    }}>
      <Popover.Trigger className="gg-recovery-trigger" aria-label={props.name + ' · ' + t(`devices.recovery.${props.state}.status`)}>
        <DeviceRecoveryStatus deviceId={props.deviceId} state={props.state} /><ChevronRight size={12} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal container={portal}><Popover.Positioner className="data-[anchor-hidden]:hidden" side="bottom" align="end" sideOffset={6}>
        <Popover.Popup className="gg-recovery-popover" finalFocus={() => {
          if (!returnToDraft.current) return true;
          const editor = composer();
          const range = caret.current;
          if (editor && range && editor.contains(range.commonAncestorContainer)) {
            const selection = editor.ownerDocument.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
          return editor ?? true;
        }}>
          <header><Popover.Title>{props.name}</Popover.Title><Popover.Close render={<IconButton size="sm" aria-label={t('devices.recovery.dismiss')}><X size={14} /></IconButton>} /></header>
          <DeviceRecoveryPanel key={props.state} {...props} inTask onDone={() => {
            returnToDraft.current = true;
            setOpen(false);
          }} />
        </Popover.Popup>
      </Popover.Positioner></Popover.Portal>
    </Popover.Root>
  </span>;
}

function MachineStatusChip({ state, lastSeenAt, label, word }: { state: ConnectionState; lastSeenAt?: string | null; label: string; word?: string }) {
  const { t } = useTranslation('common');
  const ref = useRef<HTMLSpanElement>(null);
  const compact = useCompactWhenTabsSqueezed(ref);
  return (
    // The state word is never cut. Machine name and last seen are capped, and a narrow strip (data-strip-narrow)
    // drops them so only the dot and the word stay (index.css, next to the model switch's own narrow rule). When even
    // that would push the tab below 「图标加一个字」, only the dot stays; the word is still read out and in the tooltip.
    <span
      ref={ref}
      className="flex min-w-min !shrink items-center overflow-hidden text-xs"
      data-slot="session-machine-status"
      data-compact={compact ? '' : undefined}
      title={compact ? `${label}: ${word ?? t(STATE_WORD_KEY[state])}` : undefined}
    >
      <ConnectionStatus state={state} word={word} lastSeenAt={lastSeenAt} subject={label} testId="session-machine-status" />
    </span>
  );
}

/** Below this the tab area cannot hold one tab at 「图标加一个字」 plus 「+」 (spec session-page「一格最窄」). */
const TABS_MIN_PX = 96;

/**
 * The strip's tabs take what the action row leaves (TabStripShell). When this status would squeeze them below
 * TABS_MIN_PX, it collapses to its dot. It comes back only when the tabs would still keep TABS_MIN_PX with the full
 * status (judged by the width measured before collapsing — ❌ flip back and forth).
 */
function useCompactWhenTabsSqueezed(ref: RefObject<HTMLSpanElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  const fullWidth = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const bar = el?.closest('.session-tab-bar') ?? null;
    const tabs = bar?.querySelector<HTMLElement>('[data-tabstrip-scroller]') ?? null;
    if (!el || !bar || !tabs || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      const width = el.getBoundingClientRect().width;
      if (!el.hasAttribute('data-compact')) {
        if (tabs.clientWidth < TABS_MIN_PX) {
          fullWidth.current = width;
          setCompact(true);
        }
      } else if (tabs.clientWidth + width >= TABS_MIN_PX + fullWidth.current) {
        setCompact(false);
      }
    };
    const resize = new ResizeObserver(() => flushSync(check));
    resize.observe(tabs);
    resize.observe(el);
    // The strip turning narrow / wide changes this status's own full width (index.css drops the name), and the first
    // resize after a jump is seen before that: measure again from the full status. (A 1280 → 560 jump otherwise kept
    // the 1280 width as the bar to come back, and the dot stayed alone with room to spare.)
    const mode = new MutationObserver(() => flushSync(() => setCompact(false)));
    mode.observe(bar, { attributes: true, attributeFilter: ['data-strip-narrow'] });
    return () => {
      resize.disconnect();
      mode.disconnect();
    };
  }, [ref]);
  return compact;
}

/** A session block with no session to draw yet (its machine away): the same strip position, holding only the machine's state. */
export const ColdSessionStrip = observer(function ColdSessionStrip({ children }: { children?: ReactNode }) {
  const { projectId } = useSessionViewContext();
  if (!machineRegistry.machineOf(projectId)) return <>{children}</>;
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 justify-end [-webkit-app-region:drag]" data-slot="cold-session-strip">
        <TabBarActionRow>
          <SessionMachineStatus />
        </TabBarActionRow>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
});
