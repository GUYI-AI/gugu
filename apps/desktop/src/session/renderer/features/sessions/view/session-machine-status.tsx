// Q3 (#2301): the connection state of the machine a session runs on, in that session block's own strip — the right end
// of its tab strip, the strip of a tab that went to its own window, and a minimal strip while the session is still
// cold (its tabs are not mounted yet). Each block says its own machine; nothing is said for this computer.
import { observer } from 'mobx-react-lite';
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ConnectionStatus } from '@/components/connection/ConnectionStatus';
import type { ConnectionState } from '@/components/connection/connectionState';
import { useScreenBlock } from '@renderer/app/screen-block-context';
import { headerConnectionState } from '@renderer/features/remote-hosts/header-connection-state';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { useSessionViewContext } from '../session-view-context';
import { TabBarActionRow } from '../titlebar-actions';

export const SessionMachineStatus = observer(function SessionMachineStatus() {
  const { projectId } = useSessionViewContext();
  const deviceId = machineRegistry.machineOf(projectId);
  const device = deviceId ? remoteHostsStore.device(deviceId) : null;
  const state = deviceId ? headerConnectionState(remoteHostsStore.connectionState(deviceId)) : null;
  if (!device || !state) return null;
  return <MachineStatusChip state={state} lastSeenAt={device.lastSeenAt} label={device.label} />;
});

const STATE_WORD_KEY = { online: 'connection.online', connecting: 'connection.connecting', device_offline: 'connection.deviceOffline' } as const;

function MachineStatusChip({ state, lastSeenAt, label }: { state: ConnectionState; lastSeenAt: string | null | undefined; label: string }) {
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
      title={compact ? `${label} · ${t(STATE_WORD_KEY[state])}` : undefined}
    >
      <ConnectionStatus state={state} lastSeenAt={lastSeenAt} subject={label} testId="session-machine-status" />
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

/** A cold session block (no tabs yet): the same strip position, holding only the machine's state. */
export const ColdSessionStrip = observer(function ColdSessionStrip({ children }: { children: ReactNode }) {
  const { projectId } = useSessionViewContext();
  const block = useScreenBlock();
  if (!machineRegistry.machineOf(projectId)) return <>{children}</>;
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 justify-end [-webkit-app-region:drag]" data-slot="cold-session-strip">
        <TabBarActionRow atWindowEdge={block.topRight || Boolean(block.windowId)}>
          <SessionMachineStatus />
        </TabBarActionRow>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
});
