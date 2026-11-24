// @@@engine-floor polyfills - one module for each API the bundle calls that is newer than ENGINE_FLOOR
// (scripts/build/engine-floor.mts marks them with `polyfill`; tests/unit/desktop/engineFloorGate.test.ts keeps the
// lists equal): the standard core-js module where core-js has one. Each installs only where the engine lacks the API.
// The shell loads this first in HTML. The embedded renderer imports it first to keep one module entry.
import 'core-js/modules/es.array.to-sorted.js'
import 'core-js/modules/es.promise.with-resolvers.js'
import 'core-js/modules/web.url.can-parse.js'
import 'core-js/modules/web.url.parse.js'
import 'core-js/modules/es.promise.try.js'
import './abort-signal-polyfill'
