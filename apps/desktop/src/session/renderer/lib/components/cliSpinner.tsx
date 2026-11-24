import { useContext, useEffect, useRef } from 'react';
import { stopAnimationsOffscreen } from '@gugu/session-shared/animation-visibility';
import { SurfaceShownContext } from '@/lib/retainedSurface';

/**
 * agent 在跑的那枚字形。字形本身不上色(前景墨色):「在跑」由它在转说出来(owner 2026-09-26 试玩后定,#6448)。
 *
 * 字形与节拍是全产品共用的那一枚(@gugu/session-shared/running-glyph.css:二十四态、125ms 一格、对齐文档时间轴),
 * 转动全在 CSS 里 —— 合成器上的位移,主线程不逐帧换字、不重渲。
 * 看不见就停:滚出视口、窗口不可见、所在页面没在显示时去掉动画(共用开关 data-animation-off);页签上被 × 盖住的那个由
 * 页签自己暂停(tab-close-button)。
 */
export function CLISpinner({ className = 'text-foreground/60' }: { className?: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const shown = useContext(SurfaceShownContext);

  // The same switch the transcript's glyph uses (stopAnimationsOffscreen), set on the element itself: a hidden window
  // or a scrolled-away glyph loses its animation on the spot, not on the next render.
  useEffect(() => {
    const host = element.current;
    if (!host) return;
    if (shown) return stopAnimationsOffscreen(host);
    host.setAttribute('data-animation-off', '');
    return () => host.removeAttribute('data-animation-off');
  }, [shown]);

  return (
    <span ref={element} className={`gg-running-glyph ${className}`}>
      <span className="gg-running-glyph__strip" aria-hidden="true" />
    </span>
  );
}
