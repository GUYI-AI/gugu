import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

const shim = path.resolve('scripts/release/codesign-timestamp-retry.sh')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesign-retry-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

// A stand-in for /usr/bin/codesign: records its arguments, then fails the first `failures` calls with `message`.
function fakeCodesign(name: string, failures: number, message: string, status = 1) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, 'codesign')
  fs.writeFileSync(bin, `#!/bin/bash
n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/count"
printf '%s\\n' "$@" > "${dir}/args-$n"
if [ "$n" -le ${failures} ]; then echo "$\{!#}: ${message}" >&2; exit ${status}; fi
echo "$\{!#}: signed" >&2
`, { mode: 0o755 })
  const run = (...args: string[]) => spawnSync('bash', [shim, ...args], {
    encoding: 'utf8', env: { ...process.env, GUGU_CODESIGN_REAL: bin, GUGU_CODESIGN_RETRY_DELAY: '0' },
  })
  const calls = () => Number(fs.readFileSync(path.join(dir, 'count'), 'utf8'))
  const argsOf = (n: number) => fs.readFileSync(path.join(dir, `args-${n}`), 'utf8').trimEnd().split('\n')
  return { run, calls, argsOf }
}

describe('codesign-timestamp-retry.sh', () => {
  test('signs the file again when Apple refuses the timestamp, then succeeds', () => {
    const codesign = fakeCodesign('refused-twice', 2, 'The timestamp service is not available.')
    const result = codesign.run('--sign', 'ID', '--timestamp', '/app/Electron Framework')
    expect(result.status).toBe(0)
    expect(codesign.calls()).toBe(3)
    expect(codesign.argsOf(3)).toEqual(['--sign', 'ID', '--timestamp', '/app/Electron Framework'])
    expect(result.stderr).toContain('Apple timestamp service refused (attempt 2/4); signing /app/Electron Framework again')
    expect(result.stderr).toContain('/app/Electron Framework: signed')
  })

  test('passes any other codesign failure through at once', () => {
    const codesign = fakeCodesign('other-error', 9, 'errSecInternalComponent', 3)
    const result = codesign.run('--sign', 'ID', '/app/a.node')
    expect(result.status).toBe(3)
    expect(codesign.calls()).toBe(1)
    expect(result.stderr).toContain('/app/a.node: errSecInternalComponent')
    expect(result.stderr).not.toContain('refused')
  })

  test('gives up after four refusals with codesign\'s own status and message', () => {
    const codesign = fakeCodesign('always-refused', 9, 'The timestamp service is not available.')
    const result = codesign.run('--sign', 'ID', '/app/pty.node')
    expect(result.status).toBe(1)
    expect(codesign.calls()).toBe(4)
    expect(result.stderr.trimEnd().split('\n').at(-1)).toBe('/app/pty.node: The timestamp service is not available.')
  })

  test('is executable, because developer-id-mac-sign.cjs installs it as `codesign` on PATH', () => {
    expect(fs.statSync(shim).mode & 0o111).not.toBe(0)
    const signer = fs.readFileSync(path.resolve('scripts/release/developer-id-mac-sign.cjs'), 'utf8')
    expect(signer).toContain("'codesign-timestamp-retry.sh'")
  })
})
