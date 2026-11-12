// #7199 #1931 The host's half of the assistant's instructions: markers, write-back, paths, the owner profile's file format.
// The words are the assistant App's (not in this repository); these run on the neutral test rules. What the words say is
// the App's to test.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  ASSISTANT_GUIDE_BEGIN,
  ASSISTANT_GUIDE_END,
  LEGACY_ASSISTANT_GUIDE_BEGIN,
  LEGACY_ASSISTANT_GUIDE_END,
  assistantGuide,
  assistantHomePaths,
  claudeProjectDirName,
  ownerProfileIndexLine,
  ownerProfileMarkdown,
  ownerProfileMemoryFile,
  upsertAssistantGuide,
  withDeniedTools,
  withOwnerProfileIndex,
} from '../../../../packages/core/src/shared/assistantPolicy'
import { splitInstructions } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import { NEUTRAL_ASSISTANT_RULES as rules } from '../assistantRules/neutralRules'

describe('assistantGuide', () => {
  it('the product\'s words are not in this repository: the host modules carry none', () => {
    expect(existsSync(new URL('../../../../packages/core/src/shared/assistantProductRules', import.meta.url))).toBe(false)
    for (const source of ['assistantPolicy', 'assistantWorkflow', 'assistantRulesFormat']) {
      expect(readFileSync(new URL(`../../../../packages/core/src/shared/${source}.ts`, import.meta.url), 'utf8')).not.toContain('主人')
    }
  })

  it('两种家都带头尾标记,界面那一侧(splitInstructions)认得出宿主维护的那一段', () => {
    for (const kind of ['cloud', 'computer'] as const) {
      const guide = assistantGuide(kind, rules)
      expect(guide.startsWith(ASSISTANT_GUIDE_BEGIN)).toBe(true)
      expect(guide.trimEnd().endsWith(ASSISTANT_GUIDE_END)).toBe(true)
      expect(guide).toContain(`Profile rules: ${rules.defaults.profileRulesVersion}`)
      const parts = splitInstructions(`我喜欢简短的回答。\n\n${guide}`)
      expect(parts.managed?.trim()).toBe(guide.trim())
      expect(parts.user).toBe('我喜欢简短的回答。')
    }
  })
})

describe('upsertAssistantGuide', () => {
  const guide = assistantGuide('computer', rules)
  it('没有文件 = 就是这份说明', () => {
    expect(upsertAssistantGuide('', guide)).toBe(guide)
  })
  it('文件里有人写的、没有标记 = 接在末尾,人写的原样留着', () => {
    const next = upsertAssistantGuide('我的备忘\n', guide)
    expect(next.startsWith('我的备忘\n\n')).toBe(true)
    expect(next.endsWith(guide)).toBe(true)
  })
  it('有标记 = 只换标记那一段,前后人写的都留着;再来一遍结果不变', () => {
    const old = `前面\n\n${ASSISTANT_GUIDE_BEGIN}\n旧说明\n${ASSISTANT_GUIDE_END}\n\n后面\n`
    const once = upsertAssistantGuide(old, guide)
    expect(once).toContain('前面')
    expect(once).toContain('后面')
    expect(once).not.toContain('旧说明')
    expect(upsertAssistantGuide(once, guide)).toBe(once)
  })
  it('旧标记(带「云电脑」的)就地换成新的', () => {
    const old = `${LEGACY_ASSISTANT_GUIDE_BEGIN}\n旧\n${LEGACY_ASSISTANT_GUIDE_END}\n我的\n`
    const next = upsertAssistantGuide(old, guide)
    expect(next).not.toContain('旧\n')
    expect(next).toContain('我的')
    expect(next).toContain(ASSISTANT_GUIDE_BEGIN)
  })
})

describe('assistantHomePaths', () => {
  it('云上:说明 / 技能 / 设置在 ~/.claude,记忆在 Claude Code 按工作目录记的那一夹,资料夹在主目录', () => {
    const p = assistantHomePaths('/home/wuying', '/home/wuying/助理', 'cloud')
    expect(p.instructions).toBe('/home/wuying/.claude/CLAUDE.md')
    expect(p.memoryDir).toBe(`/home/wuying/.claude/projects/${claudeProjectDirName('/home/wuying/助理')}/memory`)
    expect(p.claudeMemoryDir).toBe(p.memoryDir)
    expect(p.skillsDir).toBe('/home/wuying/.claude/skills')
    expect(p.resourcesDir).toBe('/home/wuying/给助理的资料')
  })

  it('住电脑:一个字都不落在人自己的 ~/.claude 里(除了那一夹链接),其余都在它的工作目录里', () => {
    const work = '/Users/me/.gugu/assistant'
    const p = assistantHomePaths('/Users/me', work, 'computer')
    for (const path of [p.instructions, p.memoryDir, p.memoryIndex, p.skillsDir, p.settings, p.resourcesDir]) {
      expect(path.startsWith(`${work}/`)).toBe(true)
    }
    expect(p.claudeMemoryDir).toBe(`/Users/me/.claude/projects/${claudeProjectDirName(work)}/memory`)
  })
})

describe('withDeniedTools', () => {
  it('没有设置文件 = 只禁规则里那几个', () => {
    expect(JSON.parse(withDeniedTools(null, ['CronCreate']))).toEqual({ permissions: { deny: ['CronCreate'] } })
  })
  it('已有的设置与禁用项照留,重复来不重复加', () => {
    const raw = JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'], deny: ['WebFetch'] } })
    const once = withDeniedTools(raw, ['CronCreate'])
    expect(JSON.parse(once)).toEqual({ model: 'x', permissions: { allow: ['Bash(ls)'], deny: ['WebFetch', 'CronCreate'] } })
    expect(withDeniedTools(once, ['CronCreate'])).toBe(once)
  })
  it('原文读不懂 = 抛(❌ 盖掉人写的设置)', () => {
    expect(() => withDeniedTools('{not json', ['CronCreate'])).toThrow()
    expect(() => withDeniedTools('[1]', ['CronCreate'])).toThrow()
  })
})

describe('主人的称呼和基本信息', () => {
  it('称呼必有,介绍可空', () => {
    expect(ownerProfileMarkdown({ preferredName: ' 小明 ', about: '', language: 'en-US' }, rules)).toBe('Name: 小明\nLanguage at setup: en-US')
    expect(ownerProfileMarkdown({ preferredName: '小明', about: '做设计', language: 'zh-CN' }, rules)).toBe('做设计\n\nName: 小明\nLanguage at setup: zh-CN')
  })
  it('记忆文件是 Claude Code 的记忆格式:name 是主人看得懂的短标题', () => {
    const file = ownerProfileMemoryFile('- 称呼：小明', rules)
    expect(file.startsWith(`---\nname: ${rules.labels.ownerProfileMemoryName}\ndescription: ${rules.labels.ownerProfileMemoryDescription}\n`)).toBe(true)
    expect(file).toContain('type: user')
    expect(file.trimEnd().endsWith('- 称呼：小明')).toBe(true)
  })
  it('索引补一行,已有就不重复,没有索引就新建', () => {
    const line = ownerProfileIndexLine(rules)
    expect(line).toBe(`- [${rules.labels.ownerProfileMemoryName}](owner-profile.md) — ${rules.labels.ownerProfileIndexDescription}`)
    expect(withOwnerProfileIndex(null, rules)).toBe(`${line}\n`)
    const existing = '- [暗号](code.md) — 暗号是香蕉\n'
    const once = withOwnerProfileIndex(existing, rules)
    expect(once).toBe(`${existing}${line}\n`)
    expect(withOwnerProfileIndex(once, rules)).toBe(once)
  })
})
