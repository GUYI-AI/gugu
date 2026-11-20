// @@@sessionpage — single source of truth for the app-internal module aliases,
// consumed by vite.config.mts (renderer alias table), vitest, the
// release reachability gate and the storybook configs. It must agree with tsconfig.json `paths`:
// builds read this side, the typecheck reads that one (tsconfig.json is read with JSON.parse, so the
// comment lives here).
//
// The workspace packages (`@gugu/session-*`) are not aliased: the root package.json depends on each
// with workspace:*, so every importer resolves them through node_modules and the package's own
// `exports` — the same map tsc reads. A second copy here could only drift (B2, 10-17).
//
// ORDER IS LOAD-BEARING: entries are matched top-to-bottom with @rollup/plugin-alias semantics
// (`import === key || import.startsWith(key + '/')`); `@` stays last.
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
// sessionpage/ -> electron/ -> desktop/ -> apps/ -> <repo root>
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
// @@@task-fusion — 会话页代码布局:渲染层在 apps/desktop/src/session,
// 主进程在 apps/desktop/electron/session,包在 packages/session-*。
const SESSION_RENDERER_ROOT = `${ROOT}apps/desktop/src/session`
const SESSION_MAIN_ROOT = `${ROOT}apps/desktop/electron/session`
const PKGS = `${ROOT}packages`

void HERE

/** @type {Array<[string, string]>} ordered [aliasKey, absoluteTarget] */
export const emdashAliasEntries = [
  // --- @gugu/core: the session packages import the Gugu core too (same target as tsconfig paths) ---
  ['@gugu/core', `${PKGS}/core/src`],
  // --- app-internal directory aliases (prefix targets) ---
  ['@main', `${SESSION_MAIN_ROOT}/main`],
  ['@shared', `${SESSION_RENDERER_ROOT}/shared`],
  ['@renderer', `${SESSION_RENDERER_ROOT}/renderer`],
  ['@root', SESSION_MAIN_ROOT],
  ['@tooling', `${ROOT}apps/desktop/session-tooling`],
  // NOTE: `@` (→ the session renderer `src`) is intentionally LAST. It only matches `@/...` (not `@main`,
  // `@shared`, or `@emdash/...`, whose next char is not `/`), so ordering after them is safe.
  // @@@task-fusion — 两个 UI 包的包内别名(原 @/ @react/ @styles/ @theme/ 与
  // @components/ @core/ @lib/ @state/ @styles/)彼此撞名、也与咕咕的 '@' 撞名,
  // 统一成唯一前缀。
  ['@session-ui', `${PKGS}/session-ui/src`],
  ['@session-chat', `${PKGS}/session-chat-ui/src`],
  ['@session-assets', `${SESSION_RENDERER_ROOT}/assets`],
  ['@session-types', `${SESSION_RENDERER_ROOT}/types`],
]
