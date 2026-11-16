import { useEffect, useRef, useState } from 'react';
import { useReplica } from '@/lib/replica';
import { Unknown } from '@/components/ui/Unknown';
import { featuredShot } from '../market-replicas';
import { Skeleton } from '@/components/assistant-ui/ui/skeleton';
import { cn } from '@/lib/cn';
import { Button } from '@renderer/lib/ui/button';
import type { SessionTranslate } from '../extension-consent';
import { AppLifecycleButton, type AppLifecycle } from './app-lifecycle-button';
import { ExtensionMonogram } from './extension-monogram';
import { isDecoded } from './decoded-shots';
import type { ExtensionPendingAction } from './extension-pending';
import { ResourceMenu } from '@/components/ResourceMenu';
import type { ResourceContext } from '@shared/resource-actions';

/**
 * A market feature uses its listing's first screenshot as complete artwork. App identity and
 * lifecycle controls sit below it; the image remains a keyboard-accessible detail entry.
 * Without artwork, the icon card supplies the title.
 * `card` uses the same image in the smaller 16:9 tiles on the newest shelf.
 */
export function AppFeaturedCard({
  variant = 'hero',
  hostKey,
  id,
  version,
  name,
  subtitle,
  meta,
  iconUrl,
  lifecycle,
  pending,
  pendingPercent,
  translate,
  onOpen,
  onAction,
  resource,
  actionUnknown = false,
}: {
  actionUnknown?: boolean;
  variant?: 'hero' | 'card';
  /** 哪台机器的市场(截图由那台机器答)。 */
  hostKey: string;
  id: string;
  version: string;
  name: string;
  subtitle: string;
  /** 名字下面那一小行:精选是「类别 · 发布方」,小卡是副标题。 */
  meta: string;
  iconUrl?: string | null;
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  translate: SessionTranslate;
  onOpen: () => void;
  onAction: () => void;
  resource?: ResourceContext;
}) {
  // 重启后第一帧:留下的那份小图先画,大图解码好再换(owner 10-30)。
  const reading = useReplica(featuredShot, [hostKey, id, version]);
  const shot = reading.state === 'value' ? reading.value : null;
  const isPending = reading.state === 'unknown';
  const isError = reading.state === 'error';
  const retry = () => void featuredShot.refresh(hostKey, id, version);
  // 骨架第一次换成图时等 `<img>` 解码好才露出来(❌ 先画一帧空的);之后换新一版浏览器自己留着旧的。
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [painted, setPainted] = useState(() => Boolean(shot && isDecoded(shot.src)));
  // @@@effect-flow(render) - decodes the featured picture already read so it is drawn only when decoded
  useEffect(() => {
    if (painted || !shot) return;
    let alive = true;
    const done = () => alive && setPainted(true);
    void (imageRef.current?.decode() ?? Promise.resolve()).then(done, done);
    return () => {
      alive = false;
    };
  }, [painted, shot]);
  const hidden = !painted;

  const card = variant === 'card';
  const artwork = isPending || isError || Boolean(shot);
  return (
    <ResourceMenu resource={resource ?? { kind: 'app', target: { kind: 'app-detail', extensionId: id } }}><div
      role="listitem"
      className={cn('mk-hero-card', card && 'is-card', artwork && 'has-shot')}
      data-testid={card ? `extension-card-${id}` : `app-featured-${id}`}
      onClick={onOpen}
    >
      <div className={cn('mk-hero-art', artwork ? 'is-shot' : 'is-icon')} aria-hidden={artwork ? undefined : true}>
        {isPending ? (
          <Skeleton className="absolute inset-0 rounded-none" role="status" aria-label={translate('extensions.loading')} aria-busy="true" />
        ) : isError ? (
          <div className="mk-status" role="alert">
            <span>{translate('extensions.loadFailed')}</span>
            <Button type="button" variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); retry(); }}>{translate('extensions.retry')}</Button>
          </div>
        ) : shot ? (
          <>
            <img
              ref={imageRef}
              src={shot.src}
              alt=""
              style={hidden ? { visibility: 'hidden' } : undefined}
            />
            {hidden ? (shot.placeholder
              ? <img className="absolute inset-0 h-full w-full object-cover" src={shot.placeholder} alt="" aria-hidden="true" />
              : <Skeleton className="absolute inset-0 rounded-none" role="status" aria-label={translate('extensions.loading')} aria-busy="true" />
            ) : null}
            {!card ? (
              <button type="button" className="mk-hero-open" aria-label={translate('extensions.detailsOf', { name })} />
            ) : null}
          </>
        ) : (
          <>
            {iconUrl ? <img className="mk-hero-blur" src={iconUrl} alt="" /> : null}
            <span className="mk-icon mk-hero-big">
              <ExtensionMonogram name={name} iconDataUrl={iconUrl} />
            </span>
          </>
        )}
      </div>
      {card || artwork ? null : (
        <div className="mk-hero-text">
          <span className="mk-hero-label">{translate('extensions.featured')}</span>
          {/* 大字是一颗按钮:键盘也能进它的产品页(点了冒泡到外层那个 onClick)。 */}
          <button type="button" className="mk-hero-title" aria-label={translate('extensions.detailsOf', { name })}>
            {subtitle || name}
          </button>
        </div>
      )}
      <div className="mk-hero-foot">
        <span className="mk-icon is-40">
          <ExtensionMonogram name={name} iconDataUrl={iconUrl} />
        </span>
        <span className="mk-hero-who">
          {/* 小卡上没有大字,名字就是进产品页的那颗按钮。 */}
          {card ? (
            <button type="button" className="mk-hero-name" aria-label={translate('extensions.detailsOf', { name })}>
              {name}
            </button>
          ) : (
            <b>{name}</b>
          )}
          <span>{meta}</span>
        </span>
        {actionUnknown ? <Unknown className="h-7 w-16 shrink-0" /> : (
          <AppLifecycleButton
            state={lifecycle}
            pending={pending}
            percent={pendingPercent}
            translate={translate}
            onClick={onAction}
            testId={card ? `market-row-action-${id}` : `app-featured-action-${id}`}
          />
        )}
      </div>
    </div></ResourceMenu>
  );
}
