// @@@engine-floor - the oldest browser engine the shipped renderer runs on. One number, read by:
//   - vite.config.mts `build.target` and, through it, `build.cssTarget`: JS syntax is lowered to it, and lightningcss
//     (the CSS minifier) writes an sRGB declaration ahead of every oklch()/lab() color for engines that lack them,
//   - apps/desktop/index.html's first inline script (an engine below it gets a plain "update" page, not the app),
//     whose probes must include the feature that sets the floor (tests/unit/desktop/engineFloorGate.test.ts pins this),
//   - apps/desktop/src/lib/engine-polyfills.ts: one standard core-js module per API below whose `polyfill` is set
//     (the same test keeps the two lists equal),
//   - scripts/checks/check-engine-floor.mts (the built bundle may call nothing newer, beyond the polyfilled and the
//     recorded tolerated uses).
// Android System WebView follows Chrome's numbering; iOS WKWebView follows Safari's.

export interface EngineApi {
  /** What the check looks for in built JS/CSS. */
  pattern: RegExp
  /** The engine version that first shipped it. */
  chrome: number
  safari: number
  /** The core-js module that supplies it on older engines; engine-polyfills.ts imports exactly these. */
  polyfill?: string
  /** Uses that do not raise the floor: they test for the API first, are lowered at build time, or an older engine only
   * loses polish. Say which. */
  tolerated?: { chunk: RegExp; reason: string }[]
}

export const ENGINE_APIS: Record<string, EngineApi> = {
  // Tailwind's utilities live in @layer blocks; an engine without @layer drops all of them, so nothing below 99 can work.
  '@layer': { pattern: /@layer\b/g, chrome: 99, safari: 15.4 },
  // The floor. Measured on Chrome 109 with :has() and container queries switched off: the phone composer's capsule
  // layout comes apart (the attach button drops out of it). Colors and APIs above this are supplied by the build.
  ':has()': { pattern: /:has\(/g, chrome: 105, safari: 15.4 },
  '@container': { pattern: /\bcontainer-type\b/g, chrome: 105, safari: 16 },
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
  'Promise.withResolvers': { pattern: /\bPromise\.withResolvers\b/g, chrome: 119, safari: 17.4, polyfill: 'es.promise.with-resolvers' },
  'URL.canParse': { pattern: /\bURL\.canParse\b/g, chrome: 120, safari: 17, polyfill: 'web.url.can-parse' },
  'light-dark()': {
    pattern: /\blight-dark\(/g, chrome: 123, safari: 17.5,
    tolerated: [{
      chunk: /./,
      reason: 'code-block token colors (code.css.ts; the JS hits are Shiki\'s unused defaultColor option). An older engine '
        + 'drops the declaration and the code takes the text color. It must follow each surface\'s color-scheme (inverted '
        + 'user bubbles), which [data-theme] cannot express, so it is also kept out of lightningcss\'s lowering',
    }],
  },
  'URL.parse': { pattern: /\bURL\.parse\(/g, chrome: 126, safari: 18, polyfill: 'web.url.parse' },
  'Promise.try': { pattern: /\bPromise\.try\(/g, chrome: 128, safari: 18.2, polyfill: 'es.promise.try' },
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
export const ENGINE_FLOOR = { chrome: 105, safari: 16 }

export const ENGINE_FLOOR_BUILD_TARGET = [`chrome${ENGINE_FLOOR.chrome}`, `safari${ENGINE_FLOOR.safari}`]
