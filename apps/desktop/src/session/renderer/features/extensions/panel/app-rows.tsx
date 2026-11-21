import { ResourceMenu } from '@/components/ResourceMenu';
import type { ResourceContext } from '@shared/resource-actions';
import { cn } from '@renderer/utils/utils';
import type { SessionTranslate } from '../extension-consent';
import { AppLifecycleButton, type AppLifecycle } from './app-lifecycle-button';
import { ExtensionMonogram } from './extension-monogram';
import type { ExtensionPendingAction } from './extension-pending';

/**
 * 市场里的一行(owner 10-19「参考 app store 首页」= App Store 的 App 行):图标、名字、名字下面那一句、右边那颗按钮。
 * 状态只在按钮上(安装 / 下载进度 / 打开 / 更新 / 装不了的原因),名字下面那一句只说这个 App 是什么(副标题,没写取简介第一句)。
 * 点这一行别处 = 它的产品页;名字是一颗按钮,键盘也能进产品页(点了冒泡到这一行)。
 */
export function MarketAppRow({
  id,
  name,
  subtitle,
  iconUrl,
  deprecated = false,
  lifecycle,
  pending,
  pendingPercent,
  translate,
  onOpen,
  onAction,
  resource,
}: {
  id: string;
  name: string;
  subtitle: string;
  iconUrl?: string | null;
  deprecated?: boolean;
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  translate: SessionTranslate;
  onOpen: () => void;
  onAction: () => void;
  resource?: ResourceContext;
}) {
  return (
    <ResourceMenu resource={resource ?? { kind: 'app', target: { kind: 'app-detail', extensionId: id } }}><div
      role="listitem"
      className={cn('mk-lockup', pending && 'is-busy')}
      data-testid={`extension-card-${id}`}
      aria-busy={pending ? 'true' : undefined}
      onClick={onOpen}
    >
      {/* 图标是下载站上的公开地址,滚到才取、浏览器自己缓存 —— 清单不带图标字节。 */}
      <span className="mk-icon is-64">
        <ExtensionMonogram name={name} iconDataUrl={iconUrl} />
      </span>
      <span className="mk-lockup-body">
        <span className="mk-lockup-tx">
          <button type="button" className={cn('mk-lockup-name', deprecated && 'is-deprecated')} aria-label={translate('extensions.detailsOf', { name })}>
            {name}
          </button>
          <span className="mk-lockup-sub">{subtitle}</span>
        </span>
        <AppLifecycleButton
          state={lifecycle}
          pending={pending}
          percent={pendingPercent}
          translate={translate}
          onClick={onAction}
          testId={`market-row-action-${id}`}
        />
      </span>
    </div></ResourceMenu>
  );
}
