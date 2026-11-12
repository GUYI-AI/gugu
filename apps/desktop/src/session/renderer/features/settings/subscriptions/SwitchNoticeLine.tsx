import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SwitchNotice } from './SubscriptionConnections';

/**
 * 切换没成时的那一句(订阅页那一行与资源库详情同一块)。被拒(有会话正在工作)是平常事,用安静的字色说,
 * 旁边给一键「关掉并切换」;真出错才红。
 */
export function SwitchNoticeLine({ notice }: { notice: SwitchNotice }) {
  const { translate } = useSessionMessages();
  if (notice.tone !== 'gentle') return <p className="subscription-error" role="alert">{notice.text}</p>;
  if (notice.progress !== undefined) {
    const { closed, total } = notice.progress ?? { closed: 0, total: 0 };
    return (
      <div className="subscription-switch-progress" role="status">
        <div className="subscription-quota-label">
          <span>{notice.text}</span>
          {total > 0 && <span data-testid="subscription-close-progress-count">{closed} / {total}</span>}
        </div>
        <div className="subscription-meter" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={closed}
          data-testid="subscription-close-progress">
          <i style={{ width: total > 0 ? `${(closed / total) * 100}%` : '0%' }} />
        </div>
      </div>
    );
  }
  return (
    <div className="subscription-switch-refusal">
      <p className="subscription-note" role="status">{notice.text}</p>
      {notice.closeAndSwitch && (
        <Button variant="outline" size="sm" data-testid="subscription-close-and-switch" onClick={notice.closeAndSwitch}>
          {translate('subscriptions.connections.closeAndSwitch')}
        </Button>
      )}
    </div>
  );
}
