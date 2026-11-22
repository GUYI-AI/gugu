// @@@engine-floor - the oldest browser engine the shipped renderer runs on. One number, read by:
//   - vite.config.mts `build.target` and, through it, `build.cssTarget`: JS syntax is lowered to it, and lightningcss
//     (the CSS minifier) writes an sRGB declaration ahead of every oklch()/lab() color for engines that lack them,
//   - apps/desktop/index.html's first inline script (an engine below it gets a plain "update" page, not the app),
//     which runs the `probe` of the API that sets the floor (tests/unit/desktop/engineFloorGate.test.ts pins this),
//   - apps/desktop/src/lib/engine-polyfills.ts: imports exactly the `polyfill` modules below, a standard core-js module
//     wherever core-js has one (the same test keeps the two lists equal),
//   - scripts/checks/check-engine-floor.mts (the built bundle may call nothing newer, beyond the polyfilled and the
//     recorded tolerated uses).
// Android System WebView follows Chrome's numbering; iOS WKWebView follows Safari's.

export interface EngineApi {
  /** What the check looks for in built JS/CSS. */
  pattern: RegExp
  /** The engine version that first shipped it. */
  chrome: number
  safari: number
  /** The module that supplies it on older engines, as engine-polyfills.ts imports it (it imports exactly these). */
  polyfill?: string
  /** The expression index.html's gate evaluates to tell whether the engine has it (only the floor-setting API needs one). */
  probe?: string
  /** Uses that do not raise the floor: they test for the API first, are lowered at build time, or an older engine only
   * loses polish. Say which. */
  tolerated?: { chunk: RegExp; reason: string }[]
}

export const ENGINE_APIS: Record<string, EngineApi> = {
  // The floor. Tailwind's theme, preflight and utilities live in @layer blocks; an engine without @layer drops all of them
  // (measured on Chromium 95 and 91: the app runs and sends, but buttons, chips and the composer lose their styles).
  '@layer': { pattern: /@layer\b/g, chrome: 99, safari: 15.4, probe: 'window.CSSLayerBlockRule' },
  // Measured on Chromium 99–104: every phone surface reads right without these. Phone CSS is written without them
  // (phone-composer.css, phone-look.css, phone-chat-dock.css, phone-composer-controls.css, phoneMessageMenu.css; the
  // composer root states its layout containment itself).
  ':has()': {
    pattern: /:has\(/g, chrome: 105, safari: 15.4,
    tolerated: [
      { chunk: /\.css$/, reason: 'desktop and secondary-surface polish (hover rows, tab seams, App-runtime controls); an older engine drops just that rule' },
      { chunk: /\.js$/, reason: 'Tailwind class-name strings whose rules are in the CSS; no querySelector uses :has()' },
    ],
  },
  '@container': {
    pattern: /\bcontainer-type\b/g, chrome: 105, safari: 16,
    tolerated: [{ chunk: /./, reason: 'settings, usage, App store and preview pages narrow their grids by container width; an older engine keeps the wide grid' }],
  },
  'Element.checkVisibility': {
    pattern: /\.checkVisibility\(/g, chrome: 105, safari: 17.4,
    tolerated: [{ chunk: /./, reason: 'isElementVisible (lib/elementVisibility.ts) and ChatRoot test for it first; the script strings in browser-annotation.ts and file-zoom.ts run only inside Electron\'s own Chromium' }],
  },
  'AbortSignal#throwIfAborted': { pattern: /\.throwIfAborted\(/g, chrome: 100, safari: 15.4, polyfill: './abort-signal-polyfill' },
  'AbortSignal.timeout': { pattern: /\bAbortSignal\.timeout\(/g, chrome: 103, safari: 16, polyfill: './abort-signal-polyfill' },
  'Array#toSorted': { pattern: /\.toSorted\(/g, chrome: 110, safari: 16, polyfill: 'core-js/modules/es.array.to-sorted.js' },
  'oklch()': {
    pattern: /\boklch\(/g, chrome: 111, safari: 15.4,
    tolerated: [
      { chunk: /\.css$/, reason: 'lightningcss writes an sRGB declaration (or @supports fallback for a custom property) first' },
      { chunk: /\.js$/, reason: 'runtime color strings (theme packs, editor themes): an older engine keeps the default color' },
    ],
  },
  'color-mix()': {
    pattern: /\bcolor-mix\(/g, chrome: 111, safari: 16.2,
    tolerated: [
      { chunk: /\.css$/, reason: 'color-mix-fallback.mts writes the sRGB value from the root tokens; the build log counts what they cannot settle' },
      { chunk: /\.js$/, reason: 'runtime color strings (theme packs, editor themes): an older engine keeps the default color' },
    ],
  },
  'Promise.withResolvers': { pattern: /\bPromise\.withResolvers\b/g, chrome: 119, safari: 17.4, polyfill: 'core-js/modules/es.promise.with-resolvers.js' },
  'URL.canParse': { pattern: /\bURL\.canParse\b/g, chrome: 120, safari: 17, polyfill: 'core-js/modules/web.url.can-parse.js' },
  'light-dark()': {
    pattern: /\blight-dark\(/g, chrome: 123, safari: 17.5,
    tolerated: [{
      chunk: /./,
      reason: 'code-block token colors (code.css.ts; the JS hits are Shiki\'s unused defaultColor option). An older engine '
        + 'drops the declaration and the code takes the text color. It must follow each surface\'s color-scheme (inverted '
        + 'user bubbles), which [data-theme] cannot express, so it is also kept out of lightningcss\'s lowering',
    }],
  },
  'URL.parse': { pattern: /\bURL\.parse\(/g, chrome: 126, safari: 18, polyfill: 'core-js/modules/web.url.parse.js' },
  'Promise.try': { pattern: /\bPromise\.try\(/g, chrome: 128, safari: 18.2, polyfill: 'core-js/modules/es.promise.try.js' },
  'AbortSignal.any': {
    pattern: /\bAbortSignal\.any\b/g, chrome: 116, safari: 17.4,
    tolerated: [
      { chunk: /./, reason: 'packages/core/src/shared/anySignal.ts and pdf.js both check typeof AbortSignal.any first' },
    ],
  },
  'Float16Array': {
    pattern: /\bFloat16Array\b/g, chrome: 135, safari: 18.2,
    tolerated: [{
      chunk: /./,
      reason: 'pdf.js reads typeof Float16Array into isFloat16ArraySupported; elsewhere only as an "[object Float16Array]" tag',
    }],
  },
  'RegExp.escape': {
    pattern: /\bRegExp\.escape\b/g, chrome: 136, safari: 18.2,
    tolerated: [{ chunk: /./, reason: 'callers fall back with RegExp.escape || …, or core-js polyfills it in pdf_viewer' }],
  },
  'Uint8Array.fromBase64': {
    pattern: /\.fromBase64\b/g, chrome: 140, safari: 18.2,
    tolerated: [{ chunk: /^pdf-/, reason: 'pdf.js bundles core-js, which tests the native one before using it' }],
  },
}

/** The floor itself. Raise or lower it here only; the gate probe, build target and bundle check follow. */
export const ENGINE_FLOOR = { chrome: 99, safari: 15.4 }

export const ENGINE_FLOOR_BUILD_TARGET = [`chrome${ENGINE_FLOOR.chrome}`, `safari${ENGINE_FLOOR.safari}`]
