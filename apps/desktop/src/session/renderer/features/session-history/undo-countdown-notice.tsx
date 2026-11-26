import { useEffect, useRef } from 'react';

/** 撤销窗口给提示条的那一点接口:暂停 / 接着走(按原因),以及订阅「暂停了没有」。 */
export type UndoCountdownControl = {
  totalMs: number;
  remainingMs: () => number;
  pause: (reason: 'hover' | 'blur') => void;
  resume: (reason: 'hover' | 'blur') => void;
  subscribe: (listener: (paused: boolean) => void) => () => void;
};

/**
 * 永久删除的撤销提示里的说明 + 底边那条 2px 倒计时线(第 2 稿 .toast .bar)。倒计时以删除引擎的撤销窗口为准
 * (permanent-delete-flow 的 UndoCountdown):鼠标停在提示上、窗口失焦都暂停,两样都没了才接着走 —— 线跟着停。
 * 提示条本身由 notices 画(sonner,不按自己的停留消失),窗口一过由调用方收掉。
 */
export function UndoCountdownNotice({ text, control }: { text: string; control: UndoCountdownControl }) {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const toast = bar.closest<HTMLElement>('[data-sonner-toast]');
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
    const enter = () => control.pause('hover');
    const leave = () => control.resume('hover');
    const blur = () => control.pause('blur');
    const focus = () => control.resume('blur');
    toast?.addEventListener('mouseenter', enter);
    toast?.addEventListener('mouseleave', leave);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    if (!document.hasFocus()) control.pause('blur');
    return () => {
      unsubscribe();
      animation.cancel();
      toast?.removeEventListener('mouseenter', enter);
      toast?.removeEventListener('mouseleave', leave);
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
