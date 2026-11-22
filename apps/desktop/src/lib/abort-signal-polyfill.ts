// @@@engine-floor - AbortSignal.timeout (Chrome 103 / Safari 16) and AbortSignal#throwIfAborted (Chrome 100 / Safari 15.4)
// for engines between ENGINE_FLOOR and those versions. core-js has no module for either, so this is the one hand-written
// polyfill in engine-polyfills.ts; each half installs only where the engine lacks it, with the standard's reasons.
if (typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms: number): AbortSignal => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms)
    return controller.signal
  }
}
if (typeof AbortSignal.prototype.throwIfAborted !== 'function') {
  AbortSignal.prototype.throwIfAborted = function throwIfAborted(this: AbortSignal) {
    if (this.aborted) throw this.reason
  }
}
