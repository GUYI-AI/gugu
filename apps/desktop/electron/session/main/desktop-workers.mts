// @@@desktop-workers — the one list of worker entries. desktopWorkerPath (worker-manifest.ts) spawns them;
// the build derives its entries from this list (scripts/build/product-build-entries.mts) and checks every
// `file` landed in dist-electron. `entry` is relative to apps/desktop/electron/session/. An .mts with no
// imports, so node build scripts load it as ESM too.
export const desktopWorkers = {
  'codex-task-scan': { entry: 'main/core/session-import/codex-task-worker.ts', file: 'codex-task-scan.js' },
  'cursor-import': { entry: 'main/core/session-import/cursor-worker.ts', file: 'cursor-import.js' },
  'local-session-preview': { entry: '../sessionpage/local-session-preview-worker.ts', file: 'local-session-preview.js' },
  'git-status': {
    entry: 'main/core/git/status/worker.ts',
    file: 'git-status.js',
  },
  'turn-text-backfill': {
    entry: 'main/db/turn-text-backfill-worker.ts',
    file: 'turn-text-backfill.js',
  },
  'task-turn-search': {
    entry: 'main/core/search/task-turn-search-worker.ts',
    file: 'task-turn-search.js',
  },
  acp: {
    entry: 'main/core/acp/runtime-process/entry.ts',
    file: 'acp-runtime.js',
  },
  'agent-config': {
    entry: 'main/core/agent-config/runtime-process/entry.ts',
    file: 'agent-config-runtime.js',
  },
  'fs-watch': {
    entry: 'main/core/fs-watch/runtime-process/entry.ts',
    file: 'fs-watch-runtime.js',
  },
  // #6334 用量页的 token 扫描。与上面三个不同:它是 worker_threads 线程(纯计算 + 读文件,不需要进程隔离),
  // 不是 fork 子进程;但构建形态一样 —— 同一次 lib 构建的平铺入口,按本 chunk 同目录解析。
  'usage-token-scan': {
    entry: 'main/core/usage/token-scan-worker/entry.ts',
    file: 'usage-token-scan.js',
  },
} as const;
