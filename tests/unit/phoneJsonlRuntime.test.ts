import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { it } from 'vitest'

it('runs phone JSONL history and parent-channel lifecycle regressions in their native Node harness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-jsonl-ci-'))
  try {
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
      resolve('apps/mobile/runtime/agent-entry.test.mjs'),
      resolve('apps/mobile/runtime/phone-assistant-work-history.test.mjs')], {
      env: { ...process.env, GUGU_HOME: join(root, 'home'), GUGU_USER_DATA_DIR: join(root, 'profile') },
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    const failure = error as Error & { code?: string | number; signal?: string; stdout?: string; stderr?: string }
    throw new Error([
      `Phone native Node tests failed (exit=${failure.code ?? 'unknown'}, signal=${failure.signal ?? 'none'})`,
      '--- stdout ---', failure.stdout ?? '', '--- stderr ---', failure.stderr ?? '',
    ].join('\n'), { cause: error })
  } finally { await rm(root, { recursive: true, force: true }) }
})
