// @@@engine-floor polyfills - the standard core-js module for each API the bundle calls that is newer than ENGINE_FLOOR
// (scripts/build/engine-floor.mts marks them with `polyfill`; tests/unit/desktop/engineFloorGate.test.ts keeps the
// lists equal). Each module installs only where the engine lacks the API. Every HTML entry loads this as its first
// module script, so it has run before any chunk that calls them is evaluated.
import 'core-js/modules/es.promise.with-resolvers.js'
import 'core-js/modules/web.url.can-parse.js'
import 'core-js/modules/web.url.parse.js'
import 'core-js/modules/es.promise.try.js'
