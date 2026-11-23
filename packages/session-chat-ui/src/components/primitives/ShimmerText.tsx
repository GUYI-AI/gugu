/** @jsxImportSource solid-js */
import { stopAnimationsOffscreen } from '@gugu/session-shared/animation-visibility';
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, splitProps, type JSX } from 'solid-js';
import { textShimmer, textShimmerBaseSweep, textShimmerClip, textShimmerInk, textShimmerLightInk, textShimmerLoop, textShimmerMultiline, textShimmerSweep } from '@session-chat/styles/effects.css';

/** Stationary text with a composited light sweep. The decorative copy has no DOM text or semantics. */
export function ShimmerText(props: JSX.HTMLAttributes<HTMLSpanElement> & { active: boolean; multiline?: boolean }) {
  const [local, rest] = splitProps(props, ['active', 'multiline', 'children', 'class', 'classList']);
  // One boolean, ❌ the caller's getter: a row's data object is rebuilt on every transcript update while
  // it stays active, and tracking the getter would re-run the effect below on each rebuild.
  const active = createMemo(() => !!local.active);
  const [text, setText] = createSignal('');
  let host!: HTMLSpanElement;

  // @@@shimmer-loop - the sweep and its one-second hold are one infinite compositor animation
  // (textShimmerLoop, the same one TextShimmer uses). Finishing each sweep and rewinding it from script
  // a second later cost a main-thread style pass on every frame while a turn ran (Air, 0.3.9: 750 → 400
  // recalcs a minute, renderer CPU −10%); the hold it saved never stopped compositor frames, because the
  // turn's grid loader keeps them running.
  onMount(() => {
    createEffect(() => {
      if (!active()) return;
      const syncText = () => setText(host.textContent ?? '');
      syncText();
      // Labels can contain live text nodes (elapsed time, thinking status). Only
      // content changes update the static glyph texture; animation never does.
      const content = new MutationObserver(syncText);
      content.observe(host, { subtree: true, childList: true, characterData: true });
      const stop = stopAnimationsOffscreen(host);
      onCleanup(() => { content.disconnect(); stop(); });
    });
  });

  return (
    <span {...rest} ref={host} class={local.class}
      classList={{ ...local.classList, [textShimmer]: active(), [textShimmerLoop]: active(), [textShimmerMultiline]: !!local.multiline }}>
      {local.children}
      <Show when={active()}>
        <span aria-hidden="true" class={textShimmerClip}>
          <span class={textShimmerBaseSweep}>
            <span class={textShimmerInk} data-shimmer-text={text()} />
          </span>
          <span class={textShimmerSweep}>
            <span class={`${textShimmerInk} ${textShimmerLightInk}`} data-shimmer-text={text()} />
          </span>
        </span>
      </Show>
    </span>
  );
}
