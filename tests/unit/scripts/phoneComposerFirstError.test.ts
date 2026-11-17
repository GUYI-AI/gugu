import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { H_FIRST_ERROR_PREFIX, H_FIRST_ERROR_SOURCE, readHFirstErrorFrame } from '../../../scripts/test-infra/phone-composer-first-error.mjs'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const frame = {
  version: 1, kind: 'phone-composer-first-error', source: H_FIRST_ERROR_SOURCE,
  testName: 'new-page/320/light: two lines retain natural height and separate touch targets in the actual Thread',
  phase: 'before-setContent', lineCount: 2, editorText: '第1行\n第2行\n第3行',
  errorMessage: 'Maximum update depth exceeded', hasOriginalStack: true, originalStack: 'Error: Maximum update depth exceeded\n at actualCallback',
}
const wire = (value: unknown) => H_FIRST_ERROR_PREFIX + JSON.stringify(value)
it('accepts only the exact H frame and keeps absence of an original stack explicit', () => {
  expect(readHFirstErrorFrame(wire(frame))).toEqual(frame)
  expect(readHFirstErrorFrame(wire({ ...frame, hasOriginalStack: false, originalStack: null }))?.hasOriginalStack).toBe(false)
  for (const bad of [
    { ...frame, version: 2 }, { ...frame, source: 'another.test.tsx' }, { ...frame, testName: 'ordinary error' },
    { ...frame, hasOriginalStack: false }, { ...frame, originalStack: null }, { ...frame, additional: true },
    { ...frame, phase: 'ordinary' }, { ...frame, lineCount: 4 }, { ...frame, editorText: {} },
  ]) expect(readHFirstErrorFrame(wire(bad))).toBeNull()
  for (const line of ['ordinary ' + wire(frame), wire(frame) + ' tail', H_FIRST_ERROR_PREFIX + '{', frame.errorMessage]) {
    expect(readHFirstErrorFrame(line)).toBeNull()
  }
})
function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'H-shard-cli-')); roots.push(root)
  mkdirSync(join(root, 'node_modules/vitest'), { recursive: true })
  writeFileSync(join(root, 'node_modules/vitest/vitest.mjs'), body)
  return root
}
const cli = resolve('scripts/test-infra/vitest-browser-shards.mjs')
it.each([0, 19])('preserves normal child exit %i without a diagnostic frame', code => {
  const root = fixture(`process.stdout.write('ordinary output\\n'); process.exit(${code})`)
  const result = spawnSync(process.execPath, [cli, '--project', 'session-browser', 'selected.test.ts'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(result.status).toBe(code === 0 ? 0 : 1)
  expect(result.stdout).toContain('ordinary output')
  expect(result.error).toBeUndefined()
})
it('forwards the complete real frame and refuses a zero exit from its failed child', () => {
  const root = fixture(`process.stdout.write(${JSON.stringify(wire(frame) + '\n')}); process.exit(0)`)
  const result = spawnSync(process.execPath, [cli, '--project', 'session-browser', 'selected.test.ts'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(result.status).toBe(1)
  expect(result.stdout).toContain(wire(frame))
  expect(result.stderr).toContain('remaining cases are unverified')
  expect(result.error).toBeUndefined()
})
it('stops only the emitting child and still collects every other grouped shard', () => {
  const root = fixture(`const shard=process.argv.find(a=>a.startsWith('--shard=')); if(shard==='--shard=1/2'){process.on('SIGTERM',()=>{});process.stdout.write(${JSON.stringify(wire(frame) + '\n')});setInterval(()=>{},1000)}else{process.stdout.write('other shard finished\\n');process.exit(0)}`)
  const result = spawnSync(process.execPath, [cli, '--project', 'session-browser', '--shard-group=1/1', '--shards-per-group=2'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(result.status).toBe(1)
  expect(result.stdout).toContain(wire(frame))
  expect(result.stdout).toContain('other shard finished')
  expect(result.stdout).toContain('browser shards: 1/2 passed')
  expect(result.error).toBeUndefined()
}, 15_000)
it('does not stop a child for a similar console string', () => {
  const root = fixture(`process.stdout.write(${JSON.stringify('ordinary ' + wire(frame) + '\n')});process.stdout.write('completed normally\\n')`)
  const output = execFileSync(process.execPath, [cli, '--project', 'session-browser', 'selected.test.ts'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(output).toContain('completed normally')
})

it('bounds inherited stdio after the emitting root exits without signalling its unknown holder', () => {
  const root = fixture('')
  const pidFile = join(root, 'owned-fixture-helper.pid')
  const nonce = 'H_PIPE_HOLDER_' + root.split('/').at(-1)!
  writeFileSync(join(root, 'node_modules/vitest/vitest.mjs'), `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', ${JSON.stringify(nonce)}], { stdio: ['ignore', 'inherit', 'inherit'] });
    writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
    process.stdout.write(${JSON.stringify(wire(frame) + '\n')});
    process.exit(0);
  `)
  try {
    const result = spawnSync(process.execPath, [cli, '--project', 'session-browser', 'selected.test.ts'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(wire(frame))
    expect(result.stderr).toContain('remaining writers are unverified')
    expect(result.error).toBeUndefined()
    const pid = Number(readFileSync(pidFile, 'utf8'))
    // The runner must not signal this holder. This test owns it independently.
    expect(() => process.kill(pid, 0)).not.toThrow()
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      const inventory = execFileSync('pgrep', ['-af', nonce], { encoding: 'utf8' })
      expect(inventory.split('\n').some(line => Number(line.trim().split(/\s/)[0]) === pid)).toBe(true)
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
      expect(command).toContain(nonce)
      process.kill(pid, 'SIGTERM')
    }
  }
}, 15_000)
