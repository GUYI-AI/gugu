import { Globe, Monitor } from '@/lib/icons';
import { IconButton } from '@/components/ui/IconButton';
import type { LiveWindowAction, LiveWindowSnapshot } from './types';
import { useLiveWindowLabels } from './desktop-labels';
import './live-window-header.css';

export function LiveWindowHeaderIcon({ snapshot, dispatch, compact = false }: {
  snapshot: LiveWindowSnapshot; dispatch(action: LiveWindowAction): void; compact?: boolean;
}) {
  const t = useLiveWindowLabels();
  const source = snapshot.headerSource;
  if (!source) return null;
  const label = t(!snapshot.connected ? 'disconnected' : snapshot.operating
    ? source.kind === 'browser' ? 'usingBrowser' : 'usingComputer' : source.kind === 'browser' ? 'web' : 'computer');
  const opened = snapshot.visible;
  return <span className="live-window-header" data-compact={compact || undefined}>
    <IconButton size="sm" aria-label={label} title={label} aria-pressed={opened} on={opened}
      data-live-window-toggle data-kind={source.kind} data-running={snapshot.operating || undefined}
      data-disconnected={!snapshot.connected || undefined}
      onClick={event => { event.preventDefault(); event.stopPropagation(); dispatch({ type: 'toggle-window' }); }}>
      <span className="live-window-header-glyph">{source.kind === 'browser' ? <Globe /> : <Monitor />}</span>
    </IconButton>
    {!compact && snapshot.operating && <span className="live-window-header-label">{label}</span>}
  </span>;
}

export function LiveWindowDisconnected({ connected }: { connected: boolean }) {
  const t = useLiveWindowLabels();
  return connected ? null : <div data-live-window-disconnected role="status">{t('disconnected')}</div>;
}
