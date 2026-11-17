export type NativeSkill = { id: string; name: string; description: string }
export type NativeSkillReply = { ok: true; value: { skills: NativeSkill[] } }
  | { ok: false; error: { code: string; message: string } }
type ExpectedHost = { sourceSha: string; pid: number; appVersion: string; expectedSkillNames: string[] }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Infrastructure/identity/fixture failures must never become successful UI rows. */
export function checkedNativeSkillReply(report: unknown, exit: number, expected: ExpectedHost): NativeSkillReply {
  if (!record(report) || report.sourceSha !== expected.sourceSha || report.pid !== expected.pid || report.appVersion !== expected.appVersion) {
    throw new Error('Native reader lost fixed source/version/owner binding')
  }
  if (!record(report.context) || report.context.harness !== 'codex' || report.context.projectId !== null || report.actualSkillRpcCalls !== 1) {
    throw new Error('Native reader changed the fixed default-directory RPC context')
  }
  if (!record(report.result) || report.result.transport !== 'returned' || !record(report.result.reply)) {
    throw new Error('Native transport did not return a real skill reply')
  }
  const reply = report.result.reply
  if (reply.ok === true) {
    if (exit !== 0 || report.expectedSkillsPresent !== true || !Array.isArray(expected.expectedSkillNames) || !expected.expectedSkillNames.length
      || !record(reply.value) || !Array.isArray(reply.value.skills)) throw new Error('Native positive result lacks successful private-fixture verification')
    const skills = reply.value.skills
    if (skills.some(skill => !record(skill) || typeof skill.id !== 'string' || typeof skill.name !== 'string' || typeof skill.description !== 'string')
      || !expected.expectedSkillNames.every(name => skills.some(skill => skill.name === name))) throw new Error('Native positive result is missing an expected private skill')
  } else if (reply.ok === false) {
    if (exit !== 1 || !record(reply.error) || reply.error.code !== 'skills_unavailable' || typeof reply.error.message !== 'string') {
      throw new Error('Only a real unavailable scan reply is an expected native negative result')
    }
  } else throw new Error('Native reply has no explicit result state')
  return reply as NativeSkillReply
}
