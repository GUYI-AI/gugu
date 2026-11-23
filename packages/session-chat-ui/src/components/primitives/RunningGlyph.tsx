/** @jsxImportSource solid-js */
import { stopAnimationsOffscreen } from '@gugu/session-shared/animation-visibility';
import { onCleanup, onMount } from 'solid-js';

/**
 * 「在跑」的那个记号:全产品共用的二十四态字形(@gugu/session-shared/running-glyph.css,125ms 一格,对齐共用节拍)。
 * 动画全在 CSS 里(合成器上的位移);这里只管「看不见就停」:滚出视口或窗口不可见时去掉动画。
 */
export function RunningGlyph(props: { class?: string }) {
  let host!: HTMLSpanElement;
  onMount(() => onCleanup(stopAnimationsOffscreen(host)));
  return (
    <span ref={host} class={`gg-running-glyph${props.class ? ` ${props.class}` : ''}`} aria-hidden="true" data-slot="running-glyph">
      <span class="gg-running-glyph__strip" />
    </span>
  );
}
