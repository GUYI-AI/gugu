import { useEffect, useRef } from 'react';

/** 撤销窗口给提示条的那一点接口:暂停 / 接着走(按原因),以及订阅「暂停了没有」。 */
export type UndoCountdownControl = {
  totalMs: number;
  remainingMs: () => number;
  pause: (reason: 'blur') => void;
  resume: (reason: 'blur') => void;
  subscribe: (listener: (paused: boolean) => void) => () => void;
};

/**
 * 永久删除的撤销提示里的说明 + 底边那条 2px 倒计时线(第 2 稿 .toast .bar)。倒计时以删除引擎的撤销窗口为准
 * (permanent-delete-flow 的 UndoCountdown):鼠标停在提示上(宿主报的 onHoverChange,见 undo-notice-clock)、
 * 窗口失焦(这里听)都暂停,两样都没了才接着走 —— 线跟着停。提示条本身由 notices 画,❌ 在这里摸它的 DOM。
 */
export function UndoCountdownNotice({ text, control }: { text: string; control: UndoCountdownControl }) {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const animation = bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
      duration: control.totalMs,
      fill: 'forwards',
      easing: 'linear',
    });
    animation.currentTime = control.totalMs - control.remainingMs();
    const unsubscribe = control.subscribe((paused) => {
      animation.currentTime = control.totalMs - control.remainingMs();
      if (paused) animation.pause();
      else animation.play();
    });
    const blur = () => control.pause('blur');
    const focus = () => control.resume('blur');
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    if (!document.hasFocus()) control.pause('blur');
    return () => {
      unsubscribe();
      animation.cancel();
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
    };
  }, [control]);
  return (
    <>
      <span>{text}</span>
      <div
        ref={barRef}
        aria-hidden
        data-testid="history-undo-countdown"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-foreground opacity-35"
      />
    </>
  );
}
