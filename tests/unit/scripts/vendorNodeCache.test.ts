import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const root = resolve(__dirname, '../../..')
const bash = process.platform === 'win32'
  ? join(dirname(dirname(execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0])), 'bin/bash.exe')
  : 'bash'
const portable = (path: string) => path.replace(/\\/g, '/')
const shellPath = (path: string) => portable(path).replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`)

function fixture(run: (launch: (mode: string, info?: boolean) => string, paths: { cache: string; calls: string; output: string }) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'vendor-node-test-'))
  try {
    const action = join(directory, 'action'), tools = join(directory, 'bin'), archiveRoot = join(directory, 'archive')
    for (const path of [action, tools, archiveRoot]) mkdirSync(path)
    copyFileSync(join(root, '.github/actions/setup-vendor-node/install.sh'), join(action, 'install.sh'))
    const name = 'node-v24.14.0-linux-x64', node = join(archiveRoot, name, 'bin/node')
    mkdirSync(dirname(node), { recursive: true })
    const convert = process.platform === 'win32' ? 'export VENDOR_NODE_STAGE="$(cygpath -w "$VENDOR_NODE_STAGE")" VENDOR_NODE_CACHE="$(cygpath -w "$VENDOR_NODE_CACHE")"; ' : ''
    writeFileSync(node, `#!/bin/sh\nif [ "$1" = --version ]; then echo v24.14.0; else ${convert}exec '${portable(process.execPath)}' "$@"; fi\n`)
    chmodSync(node, 0o755)
    const archive = join(directory, `${name}.tar.gz`)
    execFileSync('tar', ['-czf', archive, '-C', archiveRoot, name])
    const expected = createHash('sha256').update(readFileSync(archive)).digest('hex')
    writeFileSync(join(action, 'node-checksums.txt'), `${expected}  ${name}.tar.gz\n`)
    const calls = join(directory, 'calls'), output = join(directory, 'output'), cache = join(directory, 'cache')
    // 找到 -o 后的路径，不依赖 curl 参数数量。
    writeFileSync(join(tools, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in https://*) url="$1" ;; -o) shift; destination="$1" ;; esac; shift; done\nprintf "%s\\n" "$url" >> "$TEST_CALLS"\ncase "$url" in *download.gugu*) exit 60 ;; esac\nif [ "$TEST_MODE" = corrupt ]; then printf corrupt > "$destination"; else cp "$TEST_ARCHIVE" "$destination"; fi\n')
    chmodSync(join(tools, 'curl'), 0o755)
    const launch = (mode: string, info = false) => execFileSync(bash, ['-c', 'export PATH="$TEST_BIN:$PATH"; exec bash "$TEST_INSTALL"'], {
      cwd: directory, encoding: 'utf8', env: { ...process.env,
        TEST_BIN: shellPath(tools), TEST_INSTALL: portable(join(action, 'install.sh')), RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
        VENDOR_NODE_VERSION: '24.14.0', VENDOR_NODE_CACHE_INFO: info ? '1' : '',
        GITHUB_ACTION_PATH: shellPath(action), RUNNER_TOOL_CACHE: shellPath(cache),
        GITHUB_OUTPUT: shellPath(output), GITHUB_PATH: shellPath(join(directory, 'path')),
        TEST_CALLS: shellPath(calls), TEST_ARCHIVE: shellPath(archive), TEST_MODE: mode,
      }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    run(launch, { cache: join(cache, 'gugu-vendor-node', expected), calls, output })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

describe('verified Node CI cache', () => {
  it('computes an exact cache key without downloading or installing', () => fixture((launch, paths) => {
    launch('valid', true)
    expect(readFileSync(paths.output, 'utf8')).toContain('cache-key=vendor-node-v1-linux-x64-')
    expect(existsSync(paths.calls)).toBe(false)
    expect(existsSync(paths.cache)).toBe(false)
  }))
  it('falls back to a verified official archive, then reuses the local cache without downloads', () => fixture((launch, paths) => {
    expect(launch('valid')).toContain('trying the official archive')
    const calls = readFileSync(paths.calls, 'utf8')
    expect(calls).toContain('https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-x64.tar.gz')
    expect(launch('corrupt')).toContain('Reusing verified Node')
    expect(readFileSync(paths.calls, 'utf8')).toBe(calls)
  }))
  it('rejects a corrupt fallback archive without publishing a cache', () => fixture((launch, paths) => {
    expect(() => launch('corrupt')).toThrow()
    expect(existsSync(paths.cache)).toBe(false)
  }))
  it('restores hosted caches before install and saves only on an opted-in dev push', () => {
    const action = YAML.parse(readFileSync(join(root, '.github/actions/setup-vendor-node/action.yml'), 'utf8'))
    const steps = action.runs.steps
    const restore = steps.findIndex((step: { uses?: string }) => step.uses === 'actions/cache/restore@v4')
    expect(restore).toBeGreaterThan(-1)
    expect(restore).toBeLessThan(steps.findIndex((step: { id?: string }) => step.id === 'posix'))
    const save = steps.find((step: { uses?: string }) => step.uses === 'actions/cache/save@v4')
    for (const [event, ref, optIn, expected] of [
      ['pull_request', 'refs/pull/1/merge', 'true', false], ['workflow_dispatch', 'refs/heads/dev', 'true', false],
      ['push', 'refs/heads/main', 'true', false], ['push', 'refs/heads/dev', 'false', false], ['push', 'refs/heads/dev', 'true', true],
    ] as const) {
      const expression = save.if.replaceAll('runner.environment', '"github-hosted"').replaceAll('inputs.save-cache', JSON.stringify(optIn))
        .replaceAll('github.event_name', JSON.stringify(event)).replaceAll('github.ref', JSON.stringify(ref)).replaceAll('steps.restore.outputs.cache-hit', '"false"')
      expect(Function(`return (${expression})`)()).toBe(expected)
    }
    expect(save.with).toEqual(steps[restore].with)
  })
})
