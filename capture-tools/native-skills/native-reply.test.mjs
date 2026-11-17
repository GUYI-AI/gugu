import assert from 'node:assert/strict'
import test from 'node:test'
import { checkedNativeSkillReply } from './native-reply.ts'

const expected = { sourceSha: 'a'.repeat(40), pid: 12345, appVersion: 'synthetic-beta', expectedSkillNames: ['会议记录', '代码检查', '隔离技能读取'] }
const report = () => ({ ...expected, context: { harness: 'codex', projectId: null }, actualSkillRpcCalls: 1, expectedSkillsPresent: true,
  result: { transport: 'returned', reply: { ok: true, value: { skills: expected.expectedSkillNames.map(name => ({ id: `/private/synthetic/${name}/SKILL.md`, name, description: 'synthetic' })) } } } })

test('same-owner verified positive result requires exit zero and every private skill', () => {
  const one = report()
  assert.equal(checkedNativeSkillReply(one, 0, expected), one.result.reply)
})
test('ok true plus missing sentinel and exit one is infrastructure failure, not success', () => {
  const one = report(); one.expectedSkillsPresent = false
  one.result.reply.value.skills.pop()
  assert.throws(() => checkedNativeSkillReply(one, 1, expected), /private-fixture/)
})
test('even a claimed fixture pass cannot hide a nonzero positive reader exit', () => {
  assert.throws(() => checkedNativeSkillReply(report(), 1, expected), /private-fixture/)
})
test('exit zero cannot hide the false expected-skill verification flag', () => {
  const one = report(); one.expectedSkillsPresent = false
  assert.throws(() => checkedNativeSkillReply(one, 0, expected), /private-fixture/)
})
test('actual missing sentinel is rejected even when a report claims the flag is true', () => {
  const one = report(); one.result.reply.value.skills.pop()
  assert.throws(() => checkedNativeSkillReply(one, 0, expected), /missing an expected/)
})
test('real skills_unavailable exit one preserves its original retry error', () => {
  const one = report(); one.expectedSkillsPresent = false
  one.result.reply = { ok: false, error: { code: 'skills_unavailable', message: 'Invalid skill metadata: /private/synthetic/invalid/SKILL.md' } }
  assert.equal(checkedNativeSkillReply(one, 1, expected), one.result.reply)
})
test('a different native RPC error cannot masquerade as the scan negative control', () => {
  const one = report(); one.result.reply = { ok: false, error: { code: 'NoHandlerRegistered', message: 'No method' } }
  assert.throws(() => checkedNativeSkillReply(one, 1, expected), /Only a real/)
})
test('source, version, PID and fixed context mismatches are infrastructure failures', () => {
  for (const change of [{ sourceSha: 'b'.repeat(40) }, { pid: 54321 }, { appVersion: 'other' }, { context: { harness: 'codex', projectId: 'other' } }]) {
    assert.throws(() => checkedNativeSkillReply({ ...report(), ...change }, 0, expected))
  }
})
