## Motion nobody can see is removed, not paused

### Problem

Running highlights, avatar pulses, grid loaders and CLI spinners stop when they leave the viewport or their window is unseen, but they only pause: their animations stay attached to elements nobody can see. The running bar also keeps a hidden copy of every pill folded behind "+N", only to measure its width. That copy sits inside the viewport with `visibility: hidden`, so the viewport check never paused it, and its highlight kept running.

An animation on an element with nothing visible to draw cannot be composited. Chromium then services it on the main thread, and each main-thread animation re-styles every animated element on every frame. On a user's idle machine we watched about 60 style recalcs a second come from exactly these animations: the hidden measuring copies of the running bar, spinners and pulses. Every one of those animations reported `kAnimationHasNoVisibleChange` as its compositing failure. In a clean renderer the same copies do composite, and we have not pinned down what put that window into this state. Whatever the trigger, an animation that does not exist cannot fall back to the main thread.

### Change

- **One switch in `animation-visibility.css`:** inside an element marked `data-animation-off`, everything, pseudo-elements included, gets `animation: none !important`.
- **`stopAnimationsOffscreen`** (renamed from `pauseAnimationsOffscreen`) sets that attribute while the element is off screen or its window is unseen. On return it removes the attribute, and `joinSharedBeat` puts looping animations back on the document's shared beat, so the restart can't be seen. It starts with the attribute set, as before, so motion that never reaches the viewport never exists. Callers: `TextShimmer`, `ShimmerText`, `GridLoader`, `Avatar`.
- **`CLISpinner`** sets the same attribute instead of the old `--gugu-animation-viewport-paused` property, which is now gone.
- **`RunningTokenBar`** marks its folded measuring copies `data-animation-off`. Their size is unchanged, so fitting works as before.
- **Unchanged:**
  - Retained (`inert`) surfaces still *pause*. They keep their clocks so one-shot motion, such as an entrance fade, does not replay every time the surface is shown again.
  - The unseen-window hold (`holdAnimations`) stays for everything not under a visibility watcher.
- **Not changed: `gg-md-table-more`**, the scroll-driven mask on wide tables. It was a suspect, because mask-image can never be composited. Measured in Chromium:
  - 40 wide tables, idle: 0 style recalcs in 3 s.
  - The same 40 tables beside a main-thread animation: +0.5 ms of style work in 3 s.

  A scroll timeline that does not move is not re-sampled, so the mask costs work only while that table is scrolled. Replacing it would need script or scroll-state queries, which Android WebView lacks.

### Why this size

13 files, +109 / −82, mostly tests. The production change is one CSS rule, one function body (an attribute instead of an inline custom property), one attribute in `CLISpinner` and one in `RunningTokenBar`, plus the rename at four call sites. No new module and no new observer.

### Reuse

- The existing visibility watcher (`observeAnimationViewport`) and `joinSharedBeat`. The only new piece is what they toggle.
- The global stylesheet already loaded in every document and shadow root that animates.

### Tests

- Browser:
  - `animation-visibility`: a new case, "the hidden copies a narrow running bar keeps for measuring have no animation". It renders four running agents in a 200 px bar. Shown pills have both shimmer layers; folded copies have none. Positive control: without the attribute the case fails ("expected 2 to have a length of 0").
  - The off-screen, unseen-window and portal cases now expect the animations to be gone, then to run again with `currentTime` within 100 ms of the document timeline.
  - The inert-surface cases still expect a pause and the same clocks.
  - `running-motion`, `text-shimmer`, `grid-loader-motion`: same updates. `loading-indicator-hidden-6629` passes unchanged.
- Unit: `cliSpinner.test.ts` reads the attribute.
- Full gates on this commit: install, typecheck, unit, browser, lint, `build:renderer:ci`, permanent-removal, ui-state-debt. All green.

### Design

No visual change. A pill, spinner or pulse that comes back on screen continues on the same shared beat it would have kept.
