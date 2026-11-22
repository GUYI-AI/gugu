import { replica } from '@/lib/replica'
import { i18n } from '@/i18n/runtime'
import '@/components/session-watch/create-controls-catalog'
import { invokePhoneHost } from './phoneHostRpc'

const skillError = (key: string, values: Record<string, string | number> = {}) =>
  new Error(i18n.t(`phoneSkills.errors.${key}`, { ns: 'mobileCreateControls', ...values }))

export interface PhoneTaskSkill { id: string; name: string; description: string; instructions: string; enabled: boolean }
export interface PhoneSkillLimits { maxSkills: number; maxNameChars: number; maxDescriptionChars: number; maxInstructionChars: number; maxTotalBytes: number }
export interface PhoneTaskSkillsSnapshot {
  conversationId: string
  revision: number
  updatedAt: string | null
  skills: PhoneTaskSkill[]
  editable: boolean
  busy: boolean
  limits: PhoneSkillLimits
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const phoneSkillCharacterCount = (value: string): number => Array.from(value).length

/** Validation shared by manual editing and document import; never truncates user instructions. */
export function validatePhoneTaskSkills(skills: PhoneTaskSkill[], limits: PhoneSkillLimits): void {
  if (skills.length > limits.maxSkills) throw skillError('tooMany', { max: limits.maxSkills })
  const ids = new Set<string>()
  for (const skill of skills) {
    if (!UUID.test(skill.id) || ids.has(skill.id)) throw skillError('invalidId')
    ids.add(skill.id)
    if (!skill.name.trim() || phoneSkillCharacterCount(skill.name.trim()) > limits.maxNameChars) throw skillError('nameLength', { max: limits.maxNameChars })
    if (phoneSkillCharacterCount(skill.description) > limits.maxDescriptionChars) throw skillError('descriptionLength', { name: skill.name, max: limits.maxDescriptionChars })
    if (!skill.instructions.trim() || phoneSkillCharacterCount(skill.instructions) > limits.maxInstructionChars) throw skillError('instructionsLength', { name: skill.name, max: limits.maxInstructionChars })
  }
  if (new TextEncoder().encode(JSON.stringify(skills)).byteLength > limits.maxTotalBytes) throw skillError('totalSize')
}

function snapshot(value: PhoneTaskSkillsSnapshot, sessionId: string): PhoneTaskSkillsSnapshot {
  if (!value || value.conversationId !== sessionId || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.skills)
    || typeof value.editable !== 'boolean' || typeof value.busy !== 'boolean'
    || !value.limits || (['maxSkills', 'maxNameChars', 'maxDescriptionChars', 'maxInstructionChars', 'maxTotalBytes'] as const).some((key) => !Number.isSafeInteger(value.limits[key]) || value.limits[key] <= 0)
    || value.skills.some((skill) => !skill || typeof skill.id !== 'string' || typeof skill.name !== 'string' || typeof skill.description !== 'string' || typeof skill.instructions !== 'string' || typeof skill.enabled !== 'boolean')) {
    throw skillError('unreadable')
  }
  validatePhoneTaskSkills(value.skills, value.limits)
  return value
}

export async function readPhoneTaskSkills(deviceId: string, sessionId: string): Promise<PhoneTaskSkillsSnapshot> {
  return snapshot(await invokePhoneHost<PhoneTaskSkillsSnapshot>(deviceId, 'sessionTimeline.phoneSkillsGet', [{ conversationId: sessionId }]), sessionId)
}

/** A phone task's Skills, as its phone answers them. No push: read when the dialog opens (`fresh: 0`); a save puts what the phone kept. */
export const phoneTaskSkills = replica({
  name: 'phoneTaskSkills',
  scope: 'account',
  read: (_owner: string, deviceId: string, sessionId: string) => readPhoneTaskSkills(deviceId, sessionId),
  fresh: 0,
})

export async function savePhoneTaskSkills(deviceId: string, sessionId: string, expectedRevision: number, skills: PhoneTaskSkill[]): Promise<PhoneTaskSkillsSnapshot> {
  return snapshot(await invokePhoneHost<PhoneTaskSkillsSnapshot>(deviceId, 'sessionTimeline.phoneSkillsSet', [{ conversationId: sessionId, expectedRevision, skills }]), sessionId)
}

/** Import one document as text. Frontmatter only supplies labels; it never registers tools or loads files. */
export async function importPhoneTaskSkill(file: File, limits: PhoneSkillLimits): Promise<PhoneTaskSkill> {
  if (file.size > limits.maxTotalBytes) throw skillError('fileTooLarge')
  const text = (await file.text()).replace(/^\uFEFF/, '')
  let name = file.name.replace(/\.(md|markdown)$/i, '')
  let description = ''
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match) {
    const { parseDocument } = await import('yaml')
    const doc = parseDocument(match[1], { uniqueKeys: true })
    if (doc.errors.length) throw skillError('frontmatterParse')
    const metadata = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null
    if (metadata !== null && metadata !== undefined && (typeof metadata !== 'object' || Array.isArray(metadata))) throw skillError('frontmatterShape')
    if (metadata?.name !== undefined && typeof metadata.name !== 'string') throw skillError('nameText')
    if (metadata?.description !== undefined && typeof metadata.description !== 'string') throw skillError('descriptionText')
    name = typeof metadata?.name === 'string' ? metadata.name : name
    description = typeof metadata?.description === 'string' ? metadata.description : ''
  }
  const skill = { id: crypto.randomUUID(), name, description, instructions: text, enabled: true }
  validatePhoneTaskSkills([skill], limits)
  return skill
}
